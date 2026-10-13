// ABOUTME: Skill inventory types, pattern/override matching rules, and tree traversal helpers.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import { toPosixPath } from "./skill-discovery.ts";

export type SkillScope = "global" | "project";

export type SkillTarget = { kind: "group" | "skill"; id: string };

export type SkillStatus = "enabled" | "disabled" | "shadowed" | "invalid";

export type SkillInventoryItem = {
  kind: "skill";
  id: string;
  canonicalPath: string;
  name: string;
  description: string;
  enabled: boolean;
  status: SkillStatus;
  ruleBaseDir: string;
  ruleRelativeDir: string;
  /** skill dir relative to its sourceRoot dir, used to place it in the tree */
  treePath: string;
  sourceRoot: string;
  scope: "user" | "project";
  source: "auto" | "local";
  matchingRules: string[];
  ambiguous: boolean;
  shadowedBy?: { id: string; canonicalPath: string; name: string };
};

export type SkillGroupNode = {
  kind: "group";
  id: string;
  sourceRoot: string;
  ruleBaseDir: string;
  /** path relative to Pi's resource base, used to generate `!`/`+`/`-` rules */
  ruleBaseRelativePath: string;
  /** final path segment, used for sorting and display */
  name: string;
  scope: "user" | "project";
  source: "auto" | "local";
  state: "all-on" | "all-off" | "mixed";
  ambiguous: boolean;
  children: SkillChild[];
};

export type SkillChild = SkillInventoryItem | SkillGroupNode;

export type SkillRootKind = "pi" | "agents" | "configured";

export type SkillRoot = {
  sourceRoot: string;
  ruleBaseDir: string;
  scope: "user" | "project";
  source: "auto" | "local";
  rootKind?: SkillRootKind;
  children: SkillChild[];
};

export type SkillDiagnostic = { path?: string; message: string };

export type SkillInventory = {
  scope: SkillScope;
  settingsPath: string;
  trusted: boolean;
  roots: SkillRoot[];
  customRules: string[];
  discoveredRoots: string[];
  diagnostics: SkillDiagnostic[];
};

export type SkillMutationResult = {
  inventory: SkillInventory;
  runtimeRestartRequired: true;
};

export type BuildSkillInventoryOptions = {
  scope: SkillScope;
  cwd: string;
  agentDir: string;
  homeDir?: string;
  projectTrusted?: boolean;
};

export type MutateSkillEnabledOptions = {
  scope: SkillScope;
  cwd: string;
  agentDir: string;
  homeDir?: string;
  projectTrusted?: boolean;
  target: SkillTarget;
  enabled: boolean;
};

export type DiscoveredRoot = {
  dir: string;
  mode: "pi" | "agents";
  baseDir: string;
  scope: "user" | "project";
  source: "auto" | "local";
};

export type RawSkill = {
  canonicalPath: string;
  filePath: string;
  name: string;
  description: string;
  disableModelInvocation: boolean;
  isConfiguredFile: boolean;
  root: DiscoveredRoot;
};

export const CONFIG_DIR_NAME = ".pi";

export function resolveLocal(input: string, baseDir: string): string {
  const expanded =
    input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

export function toPosix(p: string): string {
  return toPosixPath(p);
}

function basenamePosix(p: string): string {
  const parts = toPosixPath(p).split("/");
  return parts[parts.length - 1] || "";
}

function globMatch(pattern: string, value: string): boolean {
  return minimatch(value, pattern);
}

export function isOverride(entry: string): boolean {
  return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");
}

export function isPlainGlob(entry: string): boolean {
  return !isOverride(entry) && (entry.includes("*") || entry.includes("?"));
}

export function readSettingsSkills(settingsPath: string): {
  skills: string[];
  parseError?: string;
} {
  if (!existsSync(settingsPath)) return { skills: [] };
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf-8");
  } catch {
    return { skills: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "invalid JSON";
    return { skills: [], parseError: msg };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { skills: [], parseError: "settings must be a JSON object" };
  }
  const skills = (parsed as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return { skills: [] };
  return { skills: skills.filter((s): s is string => typeof s === "string") };
}

export function normalizeExactPattern(pattern: string): string {
  let p = pattern;
  if (p.startsWith("./") || p.startsWith(".\\")) p = p.slice(2);
  return toPosix(p);
}

export type MatchContext = {
  rel: string;
  abs: string;
  name: string;
  parentRel: string;
  parentAbs: string;
  parentName: string;
};

export function buildMatchContextFromRule(ruleRelativeDir: string, baseDir: string): MatchContext {
  const rel = `${ruleRelativeDir}/SKILL.md`;
  return {
    rel,
    abs: toPosix(join(baseDir, rel)),
    name: "SKILL.md",
    parentRel: ruleRelativeDir,
    parentAbs: toPosix(join(baseDir, ruleRelativeDir)),
    parentName: basenamePosix(ruleRelativeDir),
  };
}

export function buildMatchContext(filePath: string, baseDir: string): MatchContext {
  const parent = dirname(filePath);
  return {
    rel: toPosix(relative(baseDir, filePath)),
    abs: toPosix(filePath),
    name: basenamePosix(filePath),
    parentRel: toPosix(relative(baseDir, parent)),
    parentAbs: toPosix(parent),
    parentName: basenamePosix(parent),
  };
}

export function matchesAnyPattern(ctx: MatchContext, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const p = toPosix(pattern);
    return (
      globMatch(p, ctx.rel) ||
      globMatch(p, ctx.name) ||
      globMatch(p, ctx.abs) ||
      globMatch(p, ctx.parentRel) ||
      globMatch(p, ctx.parentName) ||
      globMatch(p, ctx.parentAbs)
    );
  });
}

export function matchesAnyExact(ctx: MatchContext, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const n = normalizeExactPattern(pattern);
    if (n === ctx.rel || n === ctx.abs) return true;
    return n === ctx.parentRel || n === ctx.parentAbs;
  });
}

export function overridesOf(skills: string[]): { excl: string[]; finc: string[]; fexc: string[] } {
  const excl: string[] = [];
  const finc: string[] = [];
  const fexc: string[] = [];
  for (const e of skills) {
    if (e.startsWith("!")) excl.push(e.slice(1));
    else if (e.startsWith("+")) finc.push(e.slice(1));
    else if (e.startsWith("-")) fexc.push(e.slice(1));
  }
  return { excl, finc, fexc };
}

export function isEnabledByOverrides(
  ctx: MatchContext,
  skills: string[],
): { enabled: boolean; matched: string[] } {
  const { excl, finc, fexc } = overridesOf(skills);
  const matched: string[] = [];
  let enabled = true;
  if (excl.length > 0) {
    const hits = excl.filter((p) => matchesAnyPattern(ctx, [p]));
    if (hits.length > 0) {
      enabled = false;
      for (const h of hits) matched.push(`!${h}`);
    }
  }
  if (finc.length > 0) {
    const hits = finc.filter((p) => matchesAnyExact(ctx, [p]));
    if (hits.length > 0) {
      enabled = true;
      for (const h of hits) matched.push(`+${h}`);
    }
  }
  if (fexc.length > 0) {
    const hits = fexc.filter((p) => matchesAnyExact(ctx, [p]));
    if (hits.length > 0) {
      enabled = false;
      for (const h of hits) matched.push(`-${h}`);
    }
  }
  return { enabled, matched };
}

export function settingsPathFor(scope: SkillScope, opts: BuildSkillInventoryOptions): string {
  return scope === "global"
    ? join(opts.agentDir, "settings.json")
    : join(opts.cwd, CONFIG_DIR_NAME, "settings.json");
}

export function collectLeaves(node: { children: SkillChild[] }): SkillInventoryItem[] {
  const out: SkillInventoryItem[] = [];
  for (const c of node.children) {
    if (c.kind === "skill") out.push(c);
    else out.push(...collectLeaves(c));
  }
  return out;
}

export function findSkillInRoots(roots: SkillRoot[], id: string): SkillInventoryItem | undefined {
  for (const root of roots) {
    const found = findSkillInNode(root, id);
    if (found) return found;
  }
  return undefined;
}

function findSkillInNode(
  node: { children: SkillChild[] },
  id: string,
): SkillInventoryItem | undefined {
  for (const c of node.children) {
    if (c.kind === "skill") {
      if (c.id === id) return c;
    } else {
      const found = findSkillInNode(c, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function findGroupInRoots(roots: SkillRoot[], id: string): SkillGroupNode | undefined {
  for (const root of roots) {
    const found = findGroupInNode(root, id);
    if (found) return found;
  }
  return undefined;
}

function findGroupInNode(node: { children: SkillChild[] }, id: string): SkillGroupNode | undefined {
  for (const c of node.children) {
    if (c.kind === "group") {
      if (c.id === id) return c;
      const found = findGroupInNode(c, id);
      if (found) return found;
    }
  }
  return undefined;
}
