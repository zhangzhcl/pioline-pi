// ABOUTME: Atomic settings.json lock/read/write and skill enable/disable mutation logic.

import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { stat as asyncStat, mkdir, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type BuildSkillInventoryOptions,
  buildMatchContextFromRule,
  collectLeaves,
  findGroupInRoots,
  findSkillInRoots,
  type MutateSkillEnabledOptions,
  matchesAnyExact,
  matchesAnyPattern,
  normalizeExactPattern,
  overridesOf,
  type SkillInventory,
  type SkillInventoryItem,
  type SkillMutationResult,
  type SkillTarget,
  settingsPathFor,
  toPosix,
} from "./skill-inventory-rules.ts";

const mutationQueues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = mutationQueues.get(key) ?? Promise.resolve();
  const next = prev.then(work, work);
  mutationQueues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function migrateLegacySkills(settings: Record<string, unknown>): Record<string, unknown> {
  const skills = settings.skills;
  if (!isPlainObject(skills)) return settings;
  const legacy = skills as { enableSkillCommands?: unknown; customDirectories?: unknown };
  if (legacy.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
    settings.enableSkillCommands = legacy.enableSkillCommands;
  }
  if (Array.isArray(legacy.customDirectories) && legacy.customDirectories.length > 0) {
    settings.skills = legacy.customDirectories.filter((v): v is string => typeof v === "string");
  } else {
    delete settings.skills;
  }
  return settings;
}

export function readSettingsObject(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf-8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "parse error";
    throw new Error(`Pi settings at ${settingsPath} must be valid JSON: ${msg}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Pi settings must be a JSON object: ${settingsPath}`);
  }
  return migrateLegacySkills(parsed);
}

export function writeSettingsAtomically(settingsPath: string, next: Record<string, unknown>): void {
  const dir = dirname(settingsPath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.picot-skills-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(tmp, settingsPath);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

const SETTINGS_LOCK_STALE_MS = 10000;
const SETTINGS_LOCK_RETRY_DELAY_MS = 20;
const SETTINGS_LOCK_MAX_ATTEMPTS = 750;

function settingsLockDir(settingsPath: string): string {
  return `${settingsPath}.lock`;
}

export async function withSettingsLock<T>(settingsPath: string, critical: () => T): Promise<T> {
  const lockDir = settingsLockDir(settingsPath);
  mkdirSync(dirname(lockDir), { recursive: true });
  for (let attempt = 0; attempt < SETTINGS_LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(lockDir);
      try {
        return critical();
      } finally {
        await rmdir(lockDir).catch(() => undefined);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      let st: Stats | undefined;
      try {
        st = await asyncStat(lockDir);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (st.mtimeMs < Date.now() - SETTINGS_LOCK_STALE_MS) {
        await rmdir(lockDir).catch(() => undefined);
        continue;
      }
      await sleep(SETTINGS_LOCK_RETRY_DELAY_MS);
    }
  }
  throw new Error(`Timed out waiting for settings lock: ${lockDir}`);
}

function posixRuleForSkill(item: SkillInventoryItem): string {
  return toPosix(item.ruleRelativeDir);
}

function filterInPlace<T>(arr: T[], keep: (v: T) => boolean): void {
  for (let i = arr.length - 1; i >= 0; i--) if (!keep(arr[i])) arr.splice(i, 1);
}

function removeExactPrefix(arr: string[], rule: string, prefixes: string[]): void {
  filterInPlace(arr, (e) => {
    for (const p of prefixes) {
      if (e.startsWith(p) && normalizeExactPattern(e.slice(1)) === rule) return false;
    }
    return true;
  });
}

function ensureOverridePresent(arr: string[], prefix: string, body: string): void {
  const entry = `${prefix}${body}`;
  if (!arr.includes(entry)) arr.push(entry);
}

function computeNextSkills(
  current: string[],
  inventory: SkillInventory,
  target: SkillTarget,
  enabled: boolean,
): string[] {
  const next = current.map((e) => toPosix(e));

  if (target.kind === "skill") {
    const item = findSkillInRoots(inventory.roots, target.id);
    if (!item) throw new Error("Unknown skill target");
    const rule = posixRuleForSkill(item);
    if (!enabled) {
      ensureOverridePresent(next, "-", rule);
    } else {
      removeExactPrefix(next, rule, ["-"]);
      const ctx = buildMatchContextFromRule(item.ruleRelativeDir, item.ruleBaseDir);
      const { excl } = overridesOf(next);
      if (excl.some((p) => matchesAnyPattern(ctx, [p]))) ensureOverridePresent(next, "+", rule);
    }
    return next;
  }

  const group = findGroupInRoots(inventory.roots, target.id);
  if (!group) throw new Error("Unknown group target");
  const groupRule = toPosix(group.ruleBaseRelativePath);
  const members = collectLeaves(group);
  const memberRules = new Set(members.map((i) => posixRuleForSkill(i)));

  if (!enabled) {
    filterInPlace(
      next,
      (e) => !(e.startsWith("+") && memberRules.has(normalizeExactPattern(e.slice(1)))),
    );
    ensureOverridePresent(next, "!", `${groupRule}/**`);
  } else {
    filterInPlace(
      next,
      (e) => !(e.startsWith("!") && normalizeExactPattern(e.slice(1)) === `${groupRule}/**`),
    );
    const { excl, fexc } = overridesOf(next);
    for (const member of members) {
      const ctx = buildMatchContextFromRule(member.ruleRelativeDir, member.ruleBaseDir);
      if (matchesAnyExact(ctx, fexc)) continue;
      if (excl.some((p) => matchesAnyPattern(ctx, [p]))) {
        ensureOverridePresent(next, "+", posixRuleForSkill(member));
      }
    }
  }
  return next;
}

export async function mutateSkillEnabledWithBuilder(
  opts: MutateSkillEnabledOptions,
  buildInventory: (opts: BuildSkillInventoryOptions) => SkillInventory,
): Promise<SkillMutationResult> {
  const settingsPath = settingsPathFor(opts.scope, {
    scope: opts.scope,
    cwd: opts.cwd,
    agentDir: opts.agentDir,
  });
  return serialized(settingsPath, async () => {
    if (opts.scope === "project" && !opts.projectTrusted) {
      throw new Error("Project is not trusted; cannot mutate project skills");
    }
    const pre = buildInventory(opts);
    const expectedScope = opts.scope === "global" ? "user" : "project";
    if (opts.target.kind === "skill") {
      const item = findSkillInRoots(pre.roots, opts.target.id);
      if (!item) throw new Error("Unknown skill target");
      if (item.scope !== expectedScope) {
        throw new Error("Skill does not belong to the selected scope");
      }
      if (item.ambiguous) {
        throw new Error(
          "Skill target is ambiguous across discovery roots; edit settings.json manually",
        );
      }
    } else {
      const group = findGroupInRoots(pre.roots, opts.target.id);
      if (!group) throw new Error("Unknown group target");
      if (group.scope !== expectedScope) {
        throw new Error("Group does not belong to the selected scope");
      }
      if (group.ambiguous) {
        throw new Error(
          "Group target is ambiguous across discovery roots; edit settings.json manually",
        );
      }
    }

    await withSettingsLock(settingsPath, () => {
      const original = readSettingsObject(settingsPath);
      const currentSkills = Array.isArray(original.skills)
        ? (original.skills.filter((s) => typeof s === "string") as string[])
        : [];
      const nextSkills = computeNextSkills(currentSkills, pre, opts.target, opts.enabled);
      writeSettingsAtomically(settingsPath, { ...original, skills: nextSkills });
    });

    const inventory = buildInventory(opts);
    return { inventory, runtimeRestartRequired: true };
  });
}
