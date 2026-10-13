// @vitest-environment node

// ABOUTME: Tests for atomic skill settings mutation, lock recovery, and legacy settings migration.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir as mkdirAsync, rmdir as rmdirAsync, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BuildSkillInventoryOptions,
  buildSkillInventory,
  type MutateSkillEnabledOptions,
  mutateSkillEnabled,
  type SkillChild,
  type SkillGroupNode,
  type SkillInventory,
  type SkillInventoryItem,
} from "./skill-inventory.ts";

let tmpRoot = "";
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "skill-inv-mut-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeJson(p: string, obj: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

function writeSkill(
  dir: string,
  fm: { name?: string; description?: string; extra?: string },
): string {
  mkdirSync(dir, { recursive: true });
  const lines = ["---"];
  if (fm.name !== undefined) lines.push(`name: ${fm.name}`);
  lines.push(`description: ${fm.description ?? "default skill description"}`);
  if (fm.extra) lines.push(fm.extra);
  lines.push("---", "");
  const file = join(dir, "SKILL.md");
  writeFileSync(file, lines.join("\n"));
  return file;
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf-8"));
}

type Overrides = Partial<BuildSkillInventoryOptions> & {
  globalSettings?: { skills?: string[]; [k: string]: unknown };
  projectSettings?: { skills?: string[]; [k: string]: unknown };
};

function makeOptions(overrides: Overrides = {}): BuildSkillInventoryOptions {
  const agentDir = join(tmpRoot, "agent");
  const homeDir = join(tmpRoot, "home");
  const cwd = join(tmpRoot, "workspace");

  writeSkill(join(agentDir, "skills", "baoyu-skills", "baoyu-diagram"), {
    name: "baoyu-diagram",
    description: "diagram skill",
  });
  writeSkill(join(agentDir, "skills", "baoyu-skills", "baoyu-article-illustrator"), {
    name: "baoyu-article-illustrator",
    description: "article skill",
  });
  writeSkill(join(agentDir, "skills", "baoyu-skills", "baoyu-infographic"), {
    name: "baoyu-infographic",
    description: "info skill",
  });
  writeSkill(join(homeDir, ".agents", "skills", "research", "deep-research"), {
    name: "deep-research",
    description: "research skill",
  });
  writeSkill(join(cwd, ".pi", "skills", "release", "release-notes"), {
    name: "release-notes",
    description: "release skill",
  });

  const opts: BuildSkillInventoryOptions = {
    scope: "global",
    cwd,
    agentDir,
    homeDir,
    projectTrusted: false,
    ...overrides,
  };

  if (overrides.globalSettings)
    writeJson(join(agentDir, "settings.json"), overrides.globalSettings);
  if (overrides.projectSettings)
    writeJson(join(cwd, ".pi", "settings.json"), overrides.projectSettings);

  return opts;
}

function flatItems(inv: SkillInventory) {
  const out: SkillInventoryItem[] = [];
  const walk = (children: SkillChild[]) => {
    for (const c of children) {
      if (c.kind === "skill") out.push(c);
      else walk(c.children);
    }
  };
  for (const root of inv.roots) walk(root.children);
  return out;
}

function findGroup(inv: SkillInventory, groupRel: string): SkillGroupNode | undefined {
  const walk = (children: SkillChild[]): SkillGroupNode | undefined => {
    for (const c of children) {
      if (c.kind === "group") {
        if (c.ruleBaseRelativePath === groupRel) return c;
        const found = walk(c.children);
        if (found) return found;
      }
    }
    return undefined;
  };
  for (const root of inv.roots) {
    const found = walk(root.children);
    if (found) return found;
  }
  return undefined;
}

function findSkill(inv: SkillInventory, name: string) {
  const matches = flatItems(inv).filter((i) => i.name === name);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one "${name}", got ${matches.length}: ${JSON.stringify(matches, null, 2)}`,
    );
  }
  return matches[0];
}

function skillTarget(inv: SkillInventory, name: string) {
  return { kind: "skill" as const, id: findSkill(inv, name).id };
}

function groupTarget(inv: SkillInventory, groupRel: string) {
  const g = findGroup(inv, groupRel);
  if (!g) throw new Error(`no group ${groupRel}`);
  return { kind: "group" as const, id: g.id };
}

function mutationBase(opts: BuildSkillInventoryOptions): MutateSkillEnabledOptions {
  return { ...opts, target: { kind: "skill", id: "" }, enabled: false };
}

describe("mutation: atomic settings patches", () => {
  it("disables one skill with an exact minus rule while preserving other JSON keys", async () => {
    const opts = makeOptions({
      globalSettings: { thinkingLevel: "high", skills: ["!skills/other/**"] },
    });
    const inv = buildSkillInventory(opts);
    const result = await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "baoyu-diagram"),
      enabled: false,
    });
    expect(readJson(join(opts.agentDir, "settings.json"))).toEqual({
      thinkingLevel: "high",
      skills: ["!skills/other/**", "-skills/baoyu-skills/baoyu-diagram"],
    });
    expect(result.runtimeRestartRequired).toBe(true);
  });

  it("enables a child still excluded by its group through exactly one plus rule", async () => {
    const opts = makeOptions({
      globalSettings: { skills: ["!skills/baoyu-skills/**"] },
    });
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "baoyu-diagram"),
      enabled: true,
    });
    expect(readJson(join(opts.agentDir, "settings.json")).skills).toEqual([
      "!skills/baoyu-skills/**",
      "+skills/baoyu-skills/baoyu-diagram",
    ]);
  });

  it("disables a group with a skills-prefixed glob and removes its child plus exceptions", async () => {
    const opts = makeOptions({
      globalSettings: { skills: ["+skills/baoyu-skills/baoyu-diagram", "!skills/unrelated/**"] },
    });
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: groupTarget(inv, "skills/baoyu-skills"),
      enabled: false,
    });
    expect(readJson(join(opts.agentDir, "settings.json")).skills).toEqual([
      "!skills/unrelated/**",
      "!skills/baoyu-skills/**",
    ]);
  });

  it("enables a group under a broader exclusion and force-includes still-matched members", async () => {
    const opts = makeOptions({
      globalSettings: { skills: ["!skills/**", "-skills/baoyu-skills/baoyu-article-illustrator"] },
    });
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: groupTarget(inv, "skills/baoyu-skills"),
      enabled: true,
    });
    const skills = readJson(join(opts.agentDir, "settings.json")).skills as string[];
    expect(skills).toContain("!skills/**");
    expect(skills).toContain("-skills/baoyu-skills/baoyu-article-illustrator");
    expect(skills).toContain("+skills/baoyu-skills/baoyu-diagram");
    expect(skills).toContain("+skills/baoyu-skills/baoyu-infographic");
    expect(skills).not.toContain("+skills/baoyu-skills/baoyu-article-illustrator");
  });

  it("is idempotent on repeated disable", async () => {
    const opts = makeOptions();
    const inv = buildSkillInventory(opts);
    const target = skillTarget(inv, "baoyu-diagram");
    const base = { ...mutationBase(opts), target, enabled: false };
    await mutateSkillEnabled(base);
    await mutateSkillEnabled(base);
    expect(readJson(join(opts.agentDir, "settings.json")).skills).toEqual([
      "-skills/baoyu-skills/baoyu-diagram",
    ]);
  });

  it("rejects mutation of an untrusted project", async () => {
    const opts = makeOptions({ scope: "project", projectTrusted: false });
    await expect(
      mutateSkillEnabled({
        ...mutationBase(opts),
        target: { kind: "skill", id: "/nonexistent/SKILL.md" },
        enabled: false,
      }),
    ).rejects.toThrow(/not trusted/);
  });

  it("does not overwrite settings when the file is invalid JSON", async () => {
    const opts = makeOptions();
    const settingsPath = join(opts.agentDir, "settings.json");
    const malformed = "{ not json";
    writeFileSync(settingsPath, malformed);
    const inv = buildSkillInventory(opts);
    await expect(
      mutateSkillEnabled({
        ...mutationBase(opts),
        target: skillTarget(inv, "baoyu-diagram"),
        enabled: false,
      }),
    ).rejects.toThrow();
    expect(readFileSync(settingsPath, "utf-8")).toBe(malformed);
  });

  it("rejects an unknown target id", async () => {
    const opts = makeOptions();
    await expect(
      mutateSkillEnabled({
        ...mutationBase(opts),
        target: { kind: "skill", id: "/does/not/exist/SKILL.md" },
        enabled: false,
      }),
    ).rejects.toThrow(/Unknown skill target/);
  });

  it("rejects a skill that does not belong to the selected scope", async () => {
    const opts = makeOptions({ scope: "global", projectTrusted: true });
    const inv = buildSkillInventory(opts);
    const projectSkill = flatItems(inv).find((i) => i.scope === "project");
    expect(projectSkill).toBeDefined();
    await expect(
      mutateSkillEnabled({
        ...mutationBase(opts),
        target: { kind: "skill", id: projectSkill?.id ?? "" },
        enabled: false,
      }),
    ).rejects.toThrow(/scope/);
  });

  it("rejects mutation of a cross-root ambiguous target", async () => {
    const opts = makeOptions();
    const home = (opts as { homeDir: string }).homeDir;
    writeSkill(join(home, ".agents", "skills", "baoyu-skills", "baoyu-diagram"), {
      name: "baoyu-diagram",
      description: "dup path",
    });
    const inv = buildSkillInventory(opts);
    const ambiguous = flatItems(inv).find((i) => i.ambiguous);
    expect(ambiguous).toBeDefined();
    await expect(
      mutateSkillEnabled({
        ...mutationBase(opts),
        target: { kind: "skill", id: ambiguous?.id ?? "" },
        enabled: false,
      }),
    ).rejects.toThrow(/ambiguous/);
  });

  it("mutates project skills even when the project has no .pi/ directory yet", async () => {
    const opts = makeOptions({ scope: "project", projectTrusted: true });
    rmSync(join(opts.cwd, ".pi"), { recursive: true, force: true });
    writeSkill(join(opts.cwd, ".agents", "skills", "ag", "ag-skill"), {
      name: "ag-skill",
      description: "ag",
    });
    const inv = buildSkillInventory(opts);
    const item = flatItems(inv).find((i) => i.name === "ag-skill");
    expect(item).toBeDefined();
    await mutateSkillEnabled({
      ...mutationBase(opts),
      scope: "project",
      target: { kind: "skill", id: item?.id ?? "" },
      enabled: false,
    });
    expect(existsSync(join(opts.cwd, ".pi", "settings.json"))).toBe(true);
    expect(readJson(join(opts.cwd, ".pi", "settings.json")).skills).toEqual([
      "-skills/ag/ag-skill",
    ]);
    expect(existsSync(join(opts.cwd, ".pi", "settings.json.picot.lock"))).toBe(false);
    expect(existsSync(join(opts.cwd, ".pi", "settings.json.lock"))).toBe(false);
  });

  it("recovers from a stale settings lock left by a crashed holder", async () => {
    const opts = makeOptions();
    const settingsPath = join(opts.agentDir, "settings.json");
    const lockDir = `${settingsPath}.lock`;
    await mkdirAsync(lockDir);
    const old = new Date(Date.now() - 20000);
    await utimes(lockDir, old, old);
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "baoyu-diagram"),
      enabled: false,
    });
    expect(existsSync(lockDir)).toBe(false);
    expect(readJson(settingsPath).skills).toEqual(["-skills/baoyu-skills/baoyu-diagram"]);
  });

  it("waits for a concurrently held lock and succeeds once released", async () => {
    const opts = makeOptions();
    const settingsPath = join(opts.agentDir, "settings.json");
    const lockDir = `${settingsPath}.lock`;
    const inv = buildSkillInventory(opts);
    await mkdirAsync(lockDir);
    let released = false;
    const releaser = new Promise<void>((resolve) => {
      setTimeout(async () => {
        await rmdirAsync(lockDir);
        released = true;
        resolve();
      }, 120);
    });
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "baoyu-diagram"),
      enabled: false,
    });
    expect(released).toBe(true);
    expect(readJson(settingsPath).skills).toEqual(["-skills/baoyu-skills/baoyu-diagram"]);
    await releaser;
  });

  it("migrates a legacy skills object and preserves enableSkillCommands", async () => {
    const opts = makeOptions({
      globalSettings: {
        skills: { enableSkillCommands: false, customDirectories: ["/custom/dir"] },
      } as never,
    });
    const settingsPath = join(opts.agentDir, "settings.json");
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "baoyu-diagram"),
      enabled: false,
    });
    const result = readJson(settingsPath);
    expect(result.enableSkillCommands).toBe(false);
    expect(Array.isArray(result.skills)).toBe(true);
    expect(result.skills).toContain("-skills/baoyu-skills/baoyu-diagram");
  });

  it("writes atomically (no .tmp file left behind)", async () => {
    const opts = makeOptions();
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "baoyu-diagram"),
      enabled: false,
    });
    const { readdirSync } = await import("node:fs");
    const leftovers = readdirSync(opts.agentDir).filter((f) => f.includes(".picot-skills-"));
    expect(leftovers).toEqual([]);
    expect(existsSync(join(opts.agentDir, "settings.json"))).toBe(true);
  });
});
