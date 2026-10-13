// ABOUTME: Behavior-locked tests for package skill source parsing, identity, precedence, and roots.
// ABOUTME: Validates npm/git/local resolution, project precedence, autoload:false inheritance, and trust gating.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPackageSkillInventory,
  type ConfiguredPackageEntry,
  dedupeConfiguredPackages,
  packageIdentity,
  parsePackageSource,
  resolveInstalledPackageRoot,
} from "./package-skill-inventory.ts";

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

function makeInstalledNpm(agentDir: string, name: string, version = "1.0.0"): void {
  const dir = join(agentDir, "npm", "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
  const skillDir = join(dir, "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\nbody`);
}

describe("parsePackageSource — npm", () => {
  it("parses an unscoped npm name without version", () => {
    const r = parsePackageSource("npm:foo");
    expect(r).toMatchObject({ type: "npm", name: "foo" });
    if (r.type === "npm") {
      expect(r.version).toBeUndefined();
      expect(r.spec).toBe("foo");
    }
  });

  it("parses a scoped npm name with version range", () => {
    const r = parsePackageSource("npm:@scope/pkg@^1.2.0");
    expect(r).toMatchObject({ type: "npm", name: "@scope/pkg" });
    if (r.type === "npm") expect(r.version).toBe("^1.2.0");
  });

  it("parses a scoped npm name without version", () => {
    const r = parsePackageSource("npm:@org/lib");
    expect(r).toMatchObject({ type: "npm", name: "@org/lib" });
  });
});

describe("parsePackageSource — git", () => {
  it("parses git: shorthand as github", () => {
    const r = parsePackageSource("git:user/repo");
    expect(r.type).toBe("git");
    if (r.type === "git") {
      expect(r.host).toBe("github.com");
      expect(r.path).toBe("user/repo");
    }
  });

  it("parses git: shorthand with ref", () => {
    const r = parsePackageSource("git:user/repo#v1.0.0");
    expect(r.type).toBe("git");
    if (r.type === "git") {
      expect(r.path).toBe("user/repo");
      expect(r.ref).toBe("v1.0.0");
    }
  });

  it("parses https URL with .git suffix", () => {
    const r = parsePackageSource("https://github.com/user/repo.git");
    expect(r.type).toBe("git");
    if (r.type === "git") {
      expect(r.host).toBe("github.com");
      expect(r.path).toBe("user/repo");
    }
  });

  it("parses ssh:// explicit protocol", () => {
    const r = parsePackageSource("ssh://git@github.com:22/user/repo.git");
    expect(r.type).toBe("git");
    if (r.type === "git") {
      expect(r.host).toBe("github.com");
      expect(r.path).toBe("user/repo");
    }
  });

  it("treats git@host:path shorthand as a local source (Pi parity)", () => {
    const r = parsePackageSource("git@github.com:user/repo.git");
    expect(r.type).toBe("local");
  });
});

describe("parsePackageSource — local", () => {
  it("parses a relative local path", () => {
    const r = parsePackageSource("./local/pkg");
    expect(r).toMatchObject({ type: "local", path: "./local/pkg" });
  });

  it("parses an absolute local path", () => {
    const r = parsePackageSource("/abs/path");
    expect(r).toMatchObject({ type: "local", path: "/abs/path" });
  });

  it("falls back to local for an unknown bare string", () => {
    const r = parsePackageSource("some-bare-name");
    expect(r).toMatchObject({ type: "local", path: "some-bare-name" });
  });
});

describe("packageIdentity", () => {
  it("uses the npm name (ignores version)", () => {
    expect(packageIdentity(parsePackageSource("npm:foo@1.0.0"))).toBe("npm:foo");
    expect(packageIdentity(parsePackageSource("npm:foo@^2"))).toBe("npm:foo");
  });

  it("normalizes git to host/path without ref", () => {
    expect(packageIdentity(parsePackageSource("git:user/repo#v1"))).toBe(
      "git:github.com/user/repo",
    );
    expect(packageIdentity(parsePackageSource("https://github.com/user/repo.git"))).toBe(
      "git:github.com/user/repo",
    );
  });

  it("uses the raw local path", () => {
    expect(packageIdentity(parsePackageSource("./pkg"))).toBe("local:./pkg");
  });
});

describe("resolveInstalledPackageRoot — npm", () => {
  it("resolves a global npm package under agentDir/npm/node_modules/<name>", () => {
    const o = opts();
    makeInstalledNpm(o.agentDir, "foo");
    const parsed = parsePackageSource("npm:foo");
    const root = resolveInstalledPackageRoot(parsed, "global", o);
    expect(root).toBe(join(o.agentDir, "npm", "node_modules", "foo"));
  });

  it("resolves a project npm package under <cwd>/.pi/npm/node_modules/<name>", () => {
    const o = opts();
    const dir = join(o.cwd, ".pi", "npm", "node_modules", "foo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "foo", version: "1.0.0" }));
    const parsed = parsePackageSource("npm:foo");
    const root = resolveInstalledPackageRoot(parsed, "project", o);
    expect(root).toBe(dir);
  });
});

describe("resolveInstalledPackageRoot — git", () => {
  it("resolves a global git package under agentDir/git/<host>/<path>", () => {
    const o = opts();
    mkdirSync(join(o.agentDir, "git", "github.com", "user", "repo"), { recursive: true });
    const parsed = parsePackageSource("git:user/repo");
    const root = resolveInstalledPackageRoot(parsed, "global", o);
    expect(root).toBe(join(o.agentDir, "git", "github.com", "user", "repo"));
  });

  it("resolves a project git package under <cwd>/.pi/git/<host>/<path>", () => {
    const o = opts();
    const dir = join(o.cwd, ".pi", "git", "github.com", "user", "repo");
    mkdirSync(dir, { recursive: true });
    const parsed = parsePackageSource("https://github.com/user/repo.git");
    const root = resolveInstalledPackageRoot(parsed, "project", o);
    expect(root).toBe(dir);
  });

  it("rejects a git source whose normalized path escapes the install root", () => {
    const o = opts();
    const parsed = { type: "git" as const, repo: "x", host: "..", path: "evil", pinned: false };
    expect(() => resolveInstalledPackageRoot(parsed, "global", o)).toThrow();
  });
});

describe("resolveInstalledPackageRoot — local", () => {
  it("resolves a relative global local path against agentDir", () => {
    const o = opts();
    mkdirSync(join(o.agentDir, "mylocal"), { recursive: true });
    const parsed = parsePackageSource("./mylocal");
    const root = resolveInstalledPackageRoot(parsed, "global", o);
    expect(root).toBe(join(o.agentDir, "mylocal"));
  });

  it("resolves a relative project local path against <cwd>/.pi", () => {
    const o = opts();
    mkdirSync(join(o.cwd, ".pi", "mylocal"), { recursive: true });
    const parsed = parsePackageSource("./mylocal");
    const root = resolveInstalledPackageRoot(parsed, "project", o);
    expect(root).toBe(join(o.cwd, ".pi", "mylocal"));
  });

  it("keeps an absolute local path absolute", () => {
    const o = opts();
    const abs = join(o.agentDir, "abs-local");
    mkdirSync(abs, { recursive: true });
    const parsed = parsePackageSource(abs);
    const root = resolveInstalledPackageRoot(parsed, "global", o);
    expect(root).toBe(abs);
  });
});

describe("dedupeConfiguredPackages — precedence", () => {
  it("a project ordinary entry replaces a matching global entry", () => {
    const o = opts();
    const globalPkgs: ConfiguredPackageEntry[] = [{ source: "npm:foo", autoload: false }];
    const projectPkgs: ConfiguredPackageEntry[] = [{ source: "npm:foo", autoload: false }];
    const result = dedupeConfiguredPackages(globalPkgs, projectPkgs, {
      ...o,
      projectTrusted: true,
    });
    const fooEntries = result.filter((r) => packageIdentity(r.parsed) === "npm:foo");
    expect(fooEntries).toHaveLength(1);
    expect(fooEntries[0].scope).toBe("project");
  });

  it("unrelated entries from both scopes remain", () => {
    const o = opts();
    const globalPkgs: ConfiguredPackageEntry[] = [{ source: "npm:foo", autoload: false }];
    const projectPkgs: ConfiguredPackageEntry[] = [{ source: "npm:bar", autoload: false }];
    const result = dedupeConfiguredPackages(globalPkgs, projectPkgs, {
      ...o,
      projectTrusted: true,
    });
    expect(result.map((r) => packageIdentity(r.parsed)).sort()).toEqual(["npm:bar", "npm:foo"]);
  });

  it("project order precedes global order", () => {
    const o = opts();
    const globalPkgs: ConfiguredPackageEntry[] = [
      { source: "npm:g1", autoload: false },
      { source: "npm:g2", autoload: false },
    ];
    const projectPkgs: ConfiguredPackageEntry[] = [
      { source: "npm:p1", autoload: false },
      { source: "npm:p2", autoload: false },
    ];
    const result = dedupeConfiguredPackages(globalPkgs, projectPkgs, {
      ...o,
      projectTrusted: true,
    });
    expect(result.map((r) => packageIdentity(r.parsed))).toEqual([
      "npm:p1",
      "npm:p2",
      "npm:g1",
      "npm:g2",
    ]);
  });

  it("duplicate same-scope identities keep the first effective entry", () => {
    const o = opts();
    const globalPkgs: ConfiguredPackageEntry[] = [
      { source: "npm:foo@1.0.0", autoload: false },
      { source: "npm:foo@2.0.0", autoload: false },
    ];
    const result = dedupeConfiguredPackages(globalPkgs, [], o);
    const fooEntries = result.filter((r) => packageIdentity(r.parsed) === "npm:foo");
    expect(fooEntries).toHaveLength(1);
  });
});

describe("autoload:false source/root inheritance", () => {
  it("a matching project autoload:false delta inherits the global source", () => {
    const o = opts();
    makeInstalledNpm(o.agentDir, "foo");
    const globalPkgs: ConfiguredPackageEntry[] = [{ source: "npm:foo", autoload: false }];
    const projectPkgs: ConfiguredPackageEntry[] = [{ source: "npm:foo", autoload: true }];
    const result = dedupeConfiguredPackages(globalPkgs, projectPkgs, {
      ...o,
      projectTrusted: true,
    });
    const foo = result.find((r) => packageIdentity(r.parsed) === "npm:foo");
    expect(foo).toBeDefined();
    expect(foo?.scope).toBe("project");
    expect(foo?.installedRoot).toBe(join(o.agentDir, "npm", "node_modules", "foo"));
  });

  it("an unmatched project autoload:false delta resolves against its own project source/root", () => {
    const o = opts();
    const dir = join(o.cwd, ".pi", "npm", "node_modules", "bar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "bar", version: "1.0.0" }));
    const projectPkgs: ConfiguredPackageEntry[] = [{ source: "npm:bar", autoload: true }];
    const result = dedupeConfiguredPackages([], projectPkgs, { ...o, projectTrusted: true });
    const bar = result.find((r) => packageIdentity(r.parsed) === "npm:bar");
    expect(bar?.installedRoot).toBe(dir);
  });
});

describe("untrusted project trust gating", () => {
  it("returns empty packages and trusted:false for an untrusted project", () => {
    const o = opts({ scope: "project", projectTrusted: false });
    writeSettings(o.cwd, [{ source: "npm:secret", autoload: false }]);
    writeSettings(o.agentDir, ["npm:visible"]);
    const inv = buildPackageSkillInventory(o);
    expect(inv.trusted).toBe(false);
    expect(inv.packages).toEqual([]);
  });

  it("does not read or disclose project package paths when untrusted", () => {
    const o = opts({ scope: "project", projectTrusted: false });
    writeSettings(o.cwd, [{ source: "/secret/abs/path", autoload: false }]);
    const inv = buildPackageSkillInventory(o);
    const json = JSON.stringify(inv);
    expect(json).not.toContain("/secret/abs/path");
  });
});

describe("settings packages[] forms", () => {
  it("reads string-form entries", () => {
    const o = opts({ scope: "global" });
    makeInstalledNpm(o.agentDir, "foo");
    writeSettings(o.agentDir, ["npm:foo"]);
    const inv = buildPackageSkillInventory(o);
    expect(inv.packages.map((p) => p.identity)).toContain("npm:foo");
  });

  it("reads object-form entries { source, autoload }", () => {
    const o = opts({ scope: "global" });
    makeInstalledNpm(o.agentDir, "foo");
    writeSettings(o.agentDir, [{ source: "npm:foo", autoload: false }]);
    const inv = buildPackageSkillInventory(o);
    expect(inv.packages.map((p) => p.identity)).toContain("npm:foo");
  });

  it("reports a diagnostic for malformed settings JSON without aborting", () => {
    const o = opts({ scope: "global" });
    mkdirSync(o.agentDir, { recursive: true });
    writeFileSync(join(o.agentDir, "settings.json"), "{ not json");
    const inv = buildPackageSkillInventory(o);
    expect(inv.diagnostics.some((d) => d.message.toLowerCase().includes("json"))).toBe(true);
  });

  it("reports a diagnostic for non-object settings", () => {
    const o = opts({ scope: "global" });
    mkdirSync(o.agentDir, { recursive: true });
    writeFileSync(join(o.agentDir, "settings.json"), "[]");
    const inv = buildPackageSkillInventory(o);
    expect(inv.diagnostics.length).toBeGreaterThan(0);
  });

  it("skips non-string / malformed package entries as diagnostics", () => {
    const o = opts({ scope: "global" });
    makeInstalledNpm(o.agentDir, "foo");
    writeSettings(o.agentDir, ["npm:foo", 123, null, { not_source: "x" }]);
    const inv = buildPackageSkillInventory(o);
    expect(inv.packages.map((p) => p.identity)).toContain("npm:foo");
    expect(inv.diagnostics.length).toBeGreaterThan(0);
  });
});

describe("packages without skills are omitted", () => {
  it("omits an uninstalled package without leaking sibling dirs", () => {
    const o = opts({ scope: "global" });
    writeSettings(o.agentDir, ["npm:never-installed"]);
    const inv = buildPackageSkillInventory(o);
    expect(inv.packages.find((p) => p.identity === "npm:never-installed")).toBeUndefined();
    expect(existsSync(join(o.agentDir, "git", "github.com"))).toBe(false);
  });

  it("omits an installed package that exposes no skills", () => {
    const o = opts({ scope: "global" });
    const root = join(o.agentDir, "npm", "node_modules", "pkg");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0" }));
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    expect(inv.packages.find((p) => p.identity === "npm:pkg")).toBeUndefined();
  });

  it("retains a package that contributes skills", () => {
    const o = opts({ scope: "global" });
    const root = join(o.agentDir, "npm", "node_modules", "pkg");
    mkdirSync(join(root, "skills", "a"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "pkg", version: "1.0.0", pi: { skills: ["./skills"] } }),
    );
    writeFileSync(join(root, "skills", "a", "SKILL.md"), "---\nname: a\ndescription: a\n---\nbody");
    writeSettings(o.agentDir, ["npm:pkg"]);
    const inv = buildPackageSkillInventory(o);
    const card = inv.packages.find((p) => p.identity === "npm:pkg");
    expect(card).toBeDefined();
    expect(card?.candidates.length).toBeGreaterThan(0);
  });
});

describe("contract: parseGitUrl parity with @earendil-works/pi-coding-agent", () => {
  let piParseGitUrl:
    | ((
        s: string,
      ) => { host?: string; path?: string; repo?: string; ref?: string; pinned?: boolean } | null)
    | null = null;
  try {
    const { createRequire } = require("node:module");
    const path = require("node:path");
    const mod = createRequire(import.meta.url)(
      path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/utils/git.js"),
    );
    piParseGitUrl = mod.parseGitUrl;
  } catch {
    piParseGitUrl = null;
  }

  const fixtures = [
    "git:user/repo",
    "git:user/repo#v1",
    "git:user/repo#abc123",
    "https://github.com/user/repo.git",
    "https://github.com/user/repo",
    "ssh://git@github.com:22/user/repo.git",
    "ssh://git@gitlab.com/user/repo.git",
    "git+https://github.com/user/repo.git",
    "git@github.com:user/repo.git",
    "not-a-url",
    "github:user/repo",
  ];

  for (const f of fixtures) {
    it(`matches Pi parseGitUrl for ${JSON.stringify(f)}`, () => {
      if (!piParseGitUrl) {
        expect(true).toBe(true);
        return;
      }
      const piResult = piParseGitUrl(f);
      const parsed = parsePackageSource(f);
      if (parsed.type !== "git") {
        expect(piResult).toBeNull();
        return;
      }
      expect(piResult).not.toBeNull();
      expect(parsed).toMatchObject({
        host: piResult?.host,
        path: piResult?.path,
        repo: piResult?.repo,
        ref: piResult?.ref,
        pinned: piResult?.pinned,
      });
    });
  }
});
