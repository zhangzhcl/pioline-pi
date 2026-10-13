// ABOUTME: Tests for package skill manifest candidate collection, conventional fallback, and metadata.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPackageSkillInventory,
  collectPackageSkillCandidates,
  packageIdentity,
  parsePackageSource,
  type ResolvedPackage,
} from "./package-skill-inventory.ts";
import type { SkillDiagnostic } from "./skill-inventory.ts";

let tmp: string;

function makeTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), "pkg-skills-"));
  return tmp;
}

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

function opts(
  overrides: Partial<{
    agentDir: string;
    cwd: string;
    homeDir: string;
    scope: "global" | "project";
    projectTrusted: boolean;
  }> = {},
) {
  const base = makeTmp();
  const agentDir = overrides.agentDir ?? join(base, "agent");
  const cwd = overrides.cwd ?? join(base, "workspace");
  mkdirSync(join(agentDir, "npm", "node_modules"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "npm", "node_modules"), { recursive: true });
  mkdirSync(join(agentDir, "git"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "git"), { recursive: true });
  return {
    agentDir,
    cwd,
    homeDir: overrides.homeDir ?? join(base, "home"),
    scope: overrides.scope ?? "global",
    projectTrusted: overrides.projectTrusted ?? false,
  };
}

function writeSettings(dir: string, skills: unknown, key = "packages"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ [key]: skills }));
}

describe("collectPackageSkillCandidates — pi.skills manifest", () => {
  beforeEach(makeTmp);

  function makePkg(
    agentDir: string,
    name: string,
    piSkills: unknown,
    skills: Record<string, { name?: string; description: string }> = {},
  ): string {
    const root = join(agentDir, "npm", "node_modules", name);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name, version: "1.0.0", pi: { skills: piSkills } }),
    );
    for (const [dir, fm] of Object.entries(skills)) {
      const skillDir = join(root, dir);
      mkdirSync(skillDir, { recursive: true });
      const lines = ["---"];
      if (fm.name) lines.push(`name: ${fm.name}`);
      lines.push(`description: ${fm.description}`, "---", "body");
      writeFileSync(join(skillDir, "SKILL.md"), lines.join("\n"));
    }
    return root;
  }

  it("collects from a single directory entry in pi.skills", () => {
    const o = opts({ scope: "global" });
    makePkg(o.agentDir, "pkg", ["./skills"], { "skills/a": { name: "a", description: "a" } });
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    const card = inv.packages.find((p) => p.identity === "npm:pkg");
    expect(card?.candidates.map((c) => c.name)).toEqual(["a"]);
  });

  it("collects from multiple directory roots", () => {
    const o = opts({ scope: "global" });
    makePkg(o.agentDir, "pkg", ["./skills-one", "./skills-two"], {
      "skills-one/a": { name: "a", description: "a" },
      "skills-two/b": { name: "b", description: "b" },
    });
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    const card = inv.packages.find((p) => p.identity === "npm:pkg");
    expect(card?.candidates.map((c) => c.name).sort()).toEqual(["a", "b"]);
  });

  it("collects a direct SKILL.md manifest entry", () => {
    const o = opts({ scope: "global" });
    const root = makePkg(o.agentDir, "pkg", ["./guide.md"]);
    writeFileSync(join(root, "guide.md"), "---\nname: guide\ndescription: g\n---\nbody\n");
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    const card = inv.packages.find((p) => p.identity === "npm:pkg");
    expect(card?.candidates.map((c) => c.name)).toEqual(["guide"]);
  });

  it("collects a glob entry", () => {
    const o = opts({ scope: "global" });
    makePkg(o.agentDir, "pkg", ["./skills/*"], {
      "skills/a": { name: "a", description: "a" },
      "skills/b": { name: "b", description: "b" },
    });
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    const card = inv.packages.find((p) => p.identity === "npm:pkg");
    expect(card?.candidates.map((c) => c.name).sort()).toEqual(["a", "b"]);
  });

  it("dedupes duplicate glob + direct matches", () => {
    const o = opts({ scope: "global" });
    makePkg(o.agentDir, "pkg", ["./skills/**", "./skills/a/SKILL.md"], {
      "skills/a": { name: "a", description: "a" },
    });
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    const card = inv.packages.find((p) => p.identity === "npm:pkg");
    expect(card?.candidates.filter((c) => c.name === "a")).toHaveLength(1);
  });

  it("honors a ! exclusion override", () => {
    const o = opts({ scope: "global" });
    makePkg(o.agentDir, "pkg", ["./skills/**", "!skills/b/**"], {
      "skills/a": { name: "a", description: "a" },
      "skills/b": { name: "b", description: "b" },
    });
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    const card = inv.packages.find((p) => p.identity === "npm:pkg");
    expect(card?.candidates.map((c) => c.name).sort()).toEqual(["a"]);
  });

  it("honors a + force-include after exclusion", () => {
    const o = opts({ scope: "global" });
    makePkg(o.agentDir, "pkg", ["./skills/**", "!skills/b/**", "+skills/b"], {
      "skills/a": { name: "a", description: "a" },
      "skills/b": { name: "b", description: "b" },
    });
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    const card = inv.packages.find((p) => p.identity === "npm:pkg");
    expect(card?.candidates.map((c) => c.name).sort()).toEqual(["a", "b"]);
  });

  it("honors a - force-exclude (final precedence)", () => {
    const o = opts({ scope: "global" });
    makePkg(o.agentDir, "pkg", ["./skills/**", "+skills/b", "-skills/b"], {
      "skills/a": { name: "a", description: "a" },
      "skills/b": { name: "b", description: "b" },
    });
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    const card = inv.packages.find((p) => p.identity === "npm:pkg");
    expect(card?.candidates.map((c) => c.name).sort()).toEqual(["a"]);
  });

  it("refuses a manifest entry that escapes the package root (path traversal)", () => {
    const o = opts({ scope: "global" });
    const sibling = join(o.agentDir, "npm", "sibling");
    mkdirSync(join(sibling, "leaked"), { recursive: true });
    writeFileSync(
      join(sibling, "leaked", "SKILL.md"),
      "---\nname: leaked\ndescription: should-not-appear\n---\nbody\n",
    );
    makePkg(o.agentDir, "pkg", ["../../sibling/**"], {});
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    const card = inv.packages.find((p) => p.identity === "npm:pkg");
    expect(card).toBeUndefined();
    expect(inv.packages.flatMap((p) => p.candidates).some((c) => c.name === "leaked")).toBe(false);
  });

  it("refuses an absolute manifest entry outside the package root", () => {
    const o = opts({ scope: "global" });
    const outside = join(o.agentDir, "outside");
    mkdirSync(join(outside, "ext"), { recursive: true });
    writeFileSync(
      join(outside, "ext", "SKILL.md"),
      "---\nname: ext\ndescription: should-not-appear\n---\nbody\n",
    );
    makePkg(o.agentDir, "pkg", [`${outside.replace(/\\/g, "/")}/**`], {});
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    const card = inv.packages.find((p) => p.identity === "npm:pkg");
    expect(card).toBeUndefined();
    expect(inv.packages.flatMap((p) => p.candidates).some((c) => c.name === "ext")).toBe(false);
  });

  it("records a diagnostic when a manifest entry is refused (collector level)", () => {
    const o = opts({ scope: "global" });
    const pkgRoot = join(o.agentDir, "npm", "node_modules", "pkg");
    const outside = join(o.agentDir, "outside");
    mkdirSync(join(outside, "ext"), { recursive: true });
    writeFileSync(
      join(outside, "ext", "SKILL.md"),
      "---\nname: ext\ndescription: should-not-appear\n---\nbody",
    );
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({
        name: "pkg",
        version: "1.0.0",
        pi: { skills: [`${outside.replace(/\\/g, "/")}/**`] },
      }),
    );
    const parsed = parsePackageSource("npm:pkg");
    const resolved: ResolvedPackage = {
      parsed,
      identity: packageIdentity(parsed),
      scope: "global",
      sourceScope: "global",
      source: "npm:pkg",
      autoload: false,
      installedRoot: pkgRoot,
    };
    const diags: SkillDiagnostic[] = [];
    collectPackageSkillCandidates(resolved, diags);
    expect(diags.some((d) => /outside.*package|escape/i.test(d.message))).toBe(true);
  });
});

describe("collectPackageSkillCandidates — conventional fallback", () => {
  beforeEach(makeTmp);

  it("discovers conventional <packageRoot>/skills/ when pi.skills absent", () => {
    const o = opts({ scope: "global" });
    const root = join(o.agentDir, "npm", "node_modules", "pkg");
    mkdirSync(join(root, "skills", "conv"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0" }));
    writeFileSync(
      join(root, "skills", "conv", "SKILL.md"),
      "---\nname: conv\ndescription: c\n---\nbody\n",
    );
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    const card = inv.packages.find((p) => p.identity === "npm:pkg");
    expect(card?.candidates.map((c) => c.name)).toEqual(["conv"]);
  });

  it("collects no candidates when pi.skills is an explicit empty array", () => {
    const o = opts({ scope: "global" });
    const root = join(o.agentDir, "npm", "node_modules", "pkg");
    mkdirSync(join(root, "skills", "conv"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "pkg", version: "1.0.0", pi: { skills: [] } }),
    );
    writeFileSync(
      join(root, "skills", "conv", "SKILL.md"),
      "---\nname: conv\ndescription: c\n---\nbody\n",
    );
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    const card = inv.packages.find((p) => p.identity === "npm:pkg");
    expect(card).toBeUndefined();
  });

  it("omits an empty-manifest installed package", () => {
    const o = opts({ scope: "global" });
    const root = join(o.agentDir, "npm", "node_modules", "pkg");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0" }));
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    expect(inv.packages.find((p) => p.identity === "npm:pkg")).toBeUndefined();
  });
});

describe("collectPackageSkillCandidates — metadata", () => {
  beforeEach(makeTmp);

  it("includes source, scope, version, canonical path, POSIX relative path, stable ID", () => {
    const o = opts({ scope: "global" });
    const root = join(o.agentDir, "npm", "node_modules", "pkg");
    mkdirSync(join(root, "skills", "alpha"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "pkg", version: "2.3.4", pi: { skills: ["./skills"] } }),
    );
    writeFileSync(
      join(root, "skills", "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: a\n---\nbody\n",
    );
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    const card = inv.packages.find((p) => p.identity === "npm:pkg");
    expect(card?.source).toBe("npm:pkg");
    expect(card?.scope).toBe("global");
    expect(card?.version).toBe("2.3.4");
    const cand = card?.candidates[0];
    expect(cand?.name).toBe("alpha");
    expect(cand?.canonicalPath).toContain("alpha");
    expect(cand?.relativePath).toBe("skills/alpha");
    expect(cand?.id).toBe(`npm:pkg::${cand?.canonicalPath}`);
  });
});
