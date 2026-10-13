// @vitest-environment node

// ABOUTME: Exercises Pi-compatible skill discovery and rule resolution for the Skills Settings page.
// ABOUTME: Uses isolated temporary directories so tests never read a developer's real agent configuration.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  tmpRoot = mkdtempSync(join(tmpdir(), "skill-inv-"));
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
  duplicateSkillName?: string;
  globalConfiguredSkillName?: string;
  projectAutoSkillName?: string;
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

  if (overrides.duplicateSkillName) {
    const n = overrides.duplicateSkillName;
    writeSkill(join(cwd, ".pi", "skills", "dup", n), { name: n, description: "project dup" });
    writeSkill(join(agentDir, "skills", "dup", n), { name: n, description: "user dup" });
    opts.projectTrusted = true;
  }

  if (
    overrides.globalConfiguredSkillName &&
    overrides.projectAutoSkillName &&
    overrides.globalConfiguredSkillName === overrides.projectAutoSkillName
  ) {
    const n = overrides.globalConfiguredSkillName;
    writeSkill(join(agentDir, "external", n), { name: n, description: "global configured" });
    writeSkill(join(cwd, ".pi", "skills", "sharedgroup", n), {
      name: n,
      description: "project auto",
    });
    const existing = overrides.globalSettings ?? {};
    writeJson(join(agentDir, "settings.json"), {
      ...existing,
      skills: [...(existing.skills ?? []), `external/${n}`],
    });
    opts.projectTrusted = true;
  }

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

function findAllByName(inv: SkillInventory, name: string) {
  const matches = flatItems(inv).filter((i) => i.name === name);
  if (matches.length === 0) throw new Error(`no item named "${name}"`);
  return matches;
}

function skillTarget(inv: SkillInventory, name: string) {
  return { kind: "skill" as const, id: findSkill(inv, name).id };
}

function mutationBase(opts: BuildSkillInventoryOptions): MutateSkillEnabledOptions {
  return { ...opts, target: { kind: "skill", id: "" }, enabled: false };
}

describe("skill discovery", () => {
  it("discovers nested skills under every global root and groups rules relative to each Pi base", () => {
    const inv = buildSkillInventory(
      makeOptions({
        globalSettings: {
          skills: ["!skills/baoyu-skills/**", "+skills/baoyu-skills/baoyu-diagram"],
        },
      }),
    );

    expect(findGroup(inv, "skills/baoyu-skills")).toBeDefined();
    expect(findSkill(inv, "baoyu-diagram").enabled).toBe(true);
    expect(findSkill(inv, "deep-research").enabled).toBe(true);
  });

  it("uses a configured non-SKILL Markdown file's file path for exact overrides", async () => {
    const opts = makeOptions({ globalSettings: { skills: ["external/release.md"] } });
    const file = join(opts.agentDir, "external", "release.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "---\nname: release-file\ndescription: configured file\n---\n");
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "release-file"),
      enabled: false,
    });
    expect(readJson(join(opts.agentDir, "settings.json")).skills).toEqual([
      "external/release.md",
      "-external/release.md",
    ]);
  });

  it("does not use bare discovery-relative directory names as Pi patterns", () => {
    const inv = buildSkillInventory(
      makeOptions({ globalSettings: { skills: ["!baoyu-skills/**"] } }),
    );
    expect(findSkill(inv, "baoyu-diagram").enabled).toBe(true);
  });

  it("accepts direct Markdown at a .pi-style root but not at an .agents root", () => {
    const opts = makeOptions();
    const piRootMd = join(opts.agentDir, "skills", "loose.md");
    mkdirSync(dirname(piRootMd), { recursive: true });
    writeFileSync(piRootMd, "---\nname: loose\ndescription: root level\n---\n");
    const home = (opts as { homeDir: string }).homeDir;
    const agentsRootMd = join(home, ".agents", "skills", "ignored.md");
    mkdirSync(dirname(agentsRootMd), { recursive: true });
    writeFileSync(agentsRootMd, "---\nname: agents-loose\ndescription: excluded\n---\n");
    const inv = buildSkillInventory(opts);
    expect(flatItems(inv).some((i) => i.name === "loose")).toBe(true);
    expect(flatItems(inv).some((i) => i.name === "agents-loose")).toBe(false);
  });

  it("stops recursion under a directory that contains SKILL.md", () => {
    const opts = makeOptions();
    writeSkill(join(opts.agentDir, "skills", "nested-stop"), {
      name: "nested-stop",
      description: "top skill",
    });
    writeSkill(join(opts.agentDir, "skills", "nested-stop", "inner", "hidden"), {
      name: "inner-hidden",
      description: "must not be discovered",
    });
    const inv = buildSkillInventory(opts);
    expect(flatItems(inv).some((i) => i.name === "nested-stop")).toBe(true);
    expect(flatItems(inv).some((i) => i.name === "inner-hidden")).toBe(false);
  });

  it("excludes hidden directories, node_modules, and ignore-file entries", () => {
    const opts = makeOptions();
    writeSkill(join(opts.agentDir, "skills", ".hidden", "skill"), {
      name: "hidden-skill",
      description: "h",
    });
    writeSkill(join(opts.agentDir, "skills", "node_modules", "pkg"), {
      name: "nm-skill",
      description: "n",
    });
    const ignoredDir = join(opts.agentDir, "skills", "ignored-group", "child");
    writeSkill(ignoredDir, { name: "ignored-child", description: "i" });
    writeFileSync(join(opts.agentDir, "skills", ".gitignore"), "ignored-group/\n");
    const inv = buildSkillInventory(opts);
    const names = flatItems(inv).map((i) => i.name);
    expect(names).not.toContain("hidden-skill");
    expect(names).not.toContain("nm-skill");
    expect(names).not.toContain("ignored-child");
  });

  it("deduplicates symlinked skills by canonical path", () => {
    const opts = makeOptions();
    const real = join(opts.agentDir, "skills", "baoyu-skills", "baoyu-diagram");
    const linkDir = join(opts.agentDir, "skills", "baoyu-skills", "baoyu-diagram-link");
    try {
      symlinkSync(real, linkDir);
    } catch {
      return;
    }
    const inv = buildSkillInventory(opts);
    const matches = flatItems(inv).filter((i) => i.name === "baoyu-diagram");
    expect(matches.length).toBe(1);
  });
});

describe("rule resolution", () => {
  it("applies ! then + then - precedence and reports matching rules", () => {
    const inv = buildSkillInventory(
      makeOptions({
        globalSettings: {
          skills: [
            "!skills/baoyu-skills/**",
            "+skills/baoyu-skills/baoyu-diagram",
            "-skills/baoyu-skills/baoyu-article-illustrator",
          ],
        },
      }),
    );
    expect(findSkill(inv, "baoyu-diagram").enabled).toBe(true);
    expect(findSkill(inv, "baoyu-article-illustrator").enabled).toBe(false);
    expect(findSkill(inv, "baoyu-infographic").enabled).toBe(false);
  });

  it("derives group state as all-on / all-off / mixed", () => {
    const inv = buildSkillInventory(
      makeOptions({ globalSettings: { skills: ["!skills/baoyu-skills/**"] } }),
    );
    const group = findGroup(inv, "skills/baoyu-skills");
    expect(group?.state).toBe("all-off");
  });
});

describe("collisions and custom rules", () => {
  it("ranks a project-auto skill above a global configured skill of the same name", () => {
    const inv = buildSkillInventory(
      makeOptions({ globalConfiguredSkillName: "shared", projectAutoSkillName: "shared" }),
    );
    const [winner, loser] = findAllByName(inv, "shared");
    expect(winner.sourceRoot.replaceAll("\\", "/")).toContain("workspace/.pi/skills");
    expect(winner.status).toBe("enabled");
    expect(loser.status).toBe("shadowed");
    expect(loser.shadowedBy?.id).toBe(winner.id);
  });

  it("marks a same-scope duplicate shadowed by the higher-precedence winner", () => {
    const inv = buildSkillInventory(makeOptions({ duplicateSkillName: "review", scope: "global" }));
    const [winner, loser] = findAllByName(inv, "review");
    expect(winner.scope).toBe("project");
    expect(loser.scope).toBe("user");
    expect(loser.status).toBe("shadowed");
  });

  it("reports existing unprefixed glob entries as read-only custom rules", () => {
    const inv = buildSkillInventory(
      makeOptions({ globalSettings: { skills: ["skills/external/*"] } }),
    );
    expect(inv.customRules).toEqual(["skills/external/*"]);
  });

  it("does not mark equal rule paths in separate settings scopes ambiguous", () => {
    const opts = makeOptions({ scope: "global", projectTrusted: true });
    writeSkill(join(opts.cwd, ".pi", "skills", "baoyu-skills", "baoyu-diagram"), {
      name: "project-diagram",
      description: "project duplicate path",
    });
    const inv = buildSkillInventory(opts);
    expect(findSkill(inv, "baoyu-diagram").ambiguous).toBe(false);
    expect(findSkill(inv, "project-diagram").ambiguous).toBe(false);
  });

  it("flags a group ambiguous when two roots share its base-relative path", () => {
    const opts = makeOptions();
    const home = (opts as { homeDir: string }).homeDir;
    writeSkill(join(opts.agentDir, "skills", "suite", "a"), { name: "suite-a", description: "a" });
    writeSkill(join(home, ".agents", "skills", "suite", "b"), {
      name: "suite-b",
      description: "b",
    });
    const inv = buildSkillInventory(opts);
    const suiteGroup = findGroup(inv, "skills/suite");
    expect(suiteGroup).toBeDefined();
    expect(suiteGroup?.ambiguous).toBe(true);
  });
});

describe("project scope and trust", () => {
  it("returns no project groups and a trust diagnostic for an untrusted project", () => {
    const inv = buildSkillInventory(makeOptions({ scope: "project", projectTrusted: false }));
    expect(inv.trusted).toBe(false);
    expect(flatItems(inv).filter((i) => i.scope === "project")).toEqual([]);
    expect(inv.discoveredRoots.some((r) => r.includes(".pi"))).toBe(true);
  });

  it("discovers project skills when trusted", () => {
    const inv = buildSkillInventory(makeOptions({ scope: "project", projectTrusted: true }));
    expect(inv.trusted).toBe(true);
    expect(flatItems(inv).some((i) => i.name === "release-notes")).toBe(true);
  });
});

describe("tree grouping", () => {
  it("places a single-skill directory as a top-level skill row, not a group card", () => {
    const opts = makeOptions();
    writeSkill(join(opts.agentDir, "skills", "Humanizer-zh"), {
      name: "humanizer-zh",
      description: "hz",
    });
    const inv = buildSkillInventory(opts);
    const root = inv.roots.find((r) => r.sourceRoot === join(opts.agentDir, "skills"));
    expect(root).toBeDefined();
    expect(root?.children.some((c) => c.kind === "skill" && c.name === "humanizer-zh")).toBe(true);
    expect(root?.children.some((c) => c.kind === "group" && c.name === "Humanizer-zh")).toBe(false);
  });

  it("orders top-level skills before groups, each alphabetically by name", () => {
    const opts = makeOptions();
    writeSkill(join(opts.agentDir, "skills", "Atlas-skill"), { name: "atlas", description: "a" });
    writeSkill(join(opts.agentDir, "skills", "Zen-skill"), { name: "zen", description: "z" });
    const inv = buildSkillInventory(opts);
    const root = inv.roots.find((r) => r.sourceRoot === join(opts.agentDir, "skills"));
    const children = root?.children ?? [];
    const kinds = children.map((c) => c.kind);
    const lastSkill = kinds.lastIndexOf("skill");
    const firstGroup = kinds.indexOf("group");
    expect(lastSkill).toBeLessThan(firstGroup);
    const skillNames = children.filter((c) => c.kind === "skill").map((c) => c.name);
    expect(skillNames).toEqual([...skillNames].sort());
    const groupNames = children.filter((c) => c.kind === "group").map((c) => c.name);
    expect(groupNames).toEqual([...groupNames].sort());
  });

  it("disables a single-skill directory with an exact minus rule, never a group glob", async () => {
    const opts = makeOptions();
    writeSkill(join(opts.agentDir, "skills", "Humanizer-zh"), {
      name: "humanizer-zh",
      description: "hz",
    });
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "humanizer-zh"),
      enabled: false,
    });
    const skills = readJson(join(opts.agentDir, "settings.json")).skills as string[];
    expect(skills).toContain("-skills/Humanizer-zh");
    expect(skills.some((s) => s.startsWith("!skills/Humanizer-zh"))).toBe(false);
  });
});
