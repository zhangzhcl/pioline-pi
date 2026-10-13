// ABOUTME: Discovers and resolves Pi skills for Picot's Settings > Skills inventory.
// ABOUTME: Mirrors the embedded Pi resource rules without exposing filesystem access to the browser.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  discoverSkillsFromRoot as discoverSharedFromRoot,
  type DiscoveredSkill as SharedDiscoveredSkill,
  type SkillDiagnostic as SharedSkillDiagnostic,
  type SkillDiscoveryRoot as SharedSkillDiscoveryRoot,
} from "./skill-discovery.ts";
import {
  migrateLegacySkills,
  mutateSkillEnabledWithBuilder,
  readSettingsObject,
  withSettingsLock,
  writeSettingsAtomically,
} from "./skill-inventory-mutation.ts";
import {
  type BuildSkillInventoryOptions,
  buildMatchContext,
  CONFIG_DIR_NAME,
  type DiscoveredRoot,
  findGroupInRoots,
  findSkillInRoots,
  isEnabledByOverrides,
  isOverride,
  isPlainGlob,
  type MatchContext,
  type MutateSkillEnabledOptions,
  matchesAnyExact,
  matchesAnyPattern,
  normalizeExactPattern,
  overridesOf,
  type RawSkill,
  readSettingsSkills,
  resolveLocal,
  type SkillChild,
  type SkillDiagnostic,
  type SkillGroupNode,
  type SkillInventory,
  type SkillInventoryItem,
  type SkillMutationResult,
  type SkillRoot,
  type SkillRootKind,
  type SkillScope,
  type SkillStatus,
  type SkillTarget,
  settingsPathFor,
  toPosix,
} from "./skill-inventory-rules.ts";

export {
  type BuildSkillInventoryOptions,
  buildMatchContext,
  findGroupInRoots,
  findSkillInRoots,
  type MatchContext,
  type MutateSkillEnabledOptions,
  matchesAnyExact,
  matchesAnyPattern,
  migrateLegacySkills,
  normalizeExactPattern,
  overridesOf,
  readSettingsObject,
  type SkillChild,
  type SkillDiagnostic,
  type SkillGroupNode,
  type SkillInventory,
  type SkillInventoryItem,
  type SkillMutationResult,
  type SkillRoot,
  type SkillRootKind,
  type SkillScope,
  type SkillStatus,
  type SkillTarget,
  withSettingsLock,
  writeSettingsAtomically,
};

function toSharedScope(scope: "user" | "project"): "global" | "project" {
  return scope === "user" ? "global" : "project";
}

function adaptSharedSkill(s: SharedDiscoveredSkill): RawSkill {
  return {
    canonicalPath: s.canonicalPath,
    filePath: s.filePath,
    name: s.name,
    description: s.description,
    disableModelInvocation: s.disableModelInvocation,
    isConfiguredFile: s.isConfiguredFile,
    root: adaptSharedRoot(s.root),
  };
}

function adaptSharedRoot(r: SharedSkillDiscoveryRoot): DiscoveredRoot {
  return {
    dir: r.dir,
    mode: r.mode,
    baseDir: r.baseDir,
    scope: r.scope === "global" ? "user" : "project",
    source: r.source === "auto" || r.source === "local" ? r.source : "local",
  };
}

function discoverSkillsFromRoot(root: DiscoveredRoot, diagnostics: SkillDiagnostic[]): RawSkill[] {
  const sharedRoot: SharedSkillDiscoveryRoot = {
    dir: root.dir,
    mode: root.mode,
    baseDir: root.baseDir,
    scope: toSharedScope(root.scope),
    source: root.source,
  };
  const sharedDiags: SharedSkillDiagnostic[] = diagnostics;
  return discoverSharedFromRoot(sharedRoot, sharedDiags).map(adaptSharedSkill);
}

function precedenceRank(scope: "user" | "project", source: "auto" | "local"): number {
  const scopeBase = scope === "project" ? 0 : 2;
  return scopeBase + (source === "local" ? 0 : 1);
}

function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function collectAncestorAgentsSkillDirs(cwd: string): string[] {
  const dirs: string[] = [];
  const gitRoot = findGitRoot(cwd);
  let dir = resolve(cwd);
  for (;;) {
    dirs.push(join(dir, ".agents", "skills"));
    if (gitRoot && dir === gitRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function globalRoots(opts: BuildSkillInventoryOptions, settingsSkills: string[]): DiscoveredRoot[] {
  const home = opts.homeDir ?? homedir();
  const roots: DiscoveredRoot[] = [
    {
      dir: join(opts.agentDir, "skills"),
      mode: "pi",
      baseDir: opts.agentDir,
      scope: "user",
      source: "auto",
    },
    {
      dir: join(home, ".agents", "skills"),
      mode: "agents",
      baseDir: join(home, ".agents"),
      scope: "user",
      source: "auto",
    },
  ];
  for (const entry of settingsSkills) {
    if (isOverride(entry) || isPlainGlob(entry)) continue;
    roots.push({
      dir: resolveLocal(entry, opts.agentDir),
      mode: "pi",
      baseDir: opts.agentDir,
      scope: "user",
      source: "local",
    });
  }
  return roots;
}

function projectRoots(
  opts: BuildSkillInventoryOptions,
  settingsSkills: string[],
): DiscoveredRoot[] {
  const home = opts.homeDir ?? homedir();
  const projectBase = join(opts.cwd, CONFIG_DIR_NAME);
  const roots: DiscoveredRoot[] = [
    {
      dir: join(projectBase, "skills"),
      mode: "pi",
      baseDir: projectBase,
      scope: "project",
      source: "auto",
    },
  ];
  for (const agentsDir of collectAncestorAgentsSkillDirs(opts.cwd)) {
    if (resolve(agentsDir) === resolve(join(home, ".agents", "skills"))) continue;
    roots.push({
      dir: agentsDir,
      mode: "agents",
      baseDir: dirname(agentsDir),
      scope: "project",
      source: "auto",
    });
  }
  for (const entry of settingsSkills) {
    if (isOverride(entry) || isPlainGlob(entry)) continue;
    roots.push({
      dir: resolveLocal(entry, projectBase),
      mode: "pi",
      baseDir: projectBase,
      scope: "project",
      source: "local",
    });
  }
  return roots;
}

function projectRootPaths(opts: BuildSkillInventoryOptions): string[] {
  const home = opts.homeDir ?? homedir();
  const paths = [join(opts.cwd, CONFIG_DIR_NAME, "skills")];
  for (const agentsDir of collectAncestorAgentsSkillDirs(opts.cwd)) {
    if (resolve(agentsDir) === resolve(join(home, ".agents", "skills"))) continue;
    paths.push(agentsDir);
  }
  return paths;
}

function detectRootKind(dir: string, opts: BuildSkillInventoryOptions): SkillRootKind {
  const home = opts.homeDir ?? homedir();
  if (dir === join(opts.agentDir, "skills")) return "pi";
  if (dir === join(opts.cwd, CONFIG_DIR_NAME, "skills")) return "pi";
  if (dir === join(home, ".agents", "skills")) return "agents";
  if (dir.startsWith(`${join(home, ".agents")}/skills/`)) return "agents";
  return "configured";
}

function insertSkillIntoTree(
  tree: SkillRoot,
  item: SkillInventoryItem,
  meta: DiscoveredRoot,
): void {
  const segs = item.treePath ? item.treePath.split("/").filter(Boolean) : [];
  let node: { children: SkillChild[] } = tree;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (i === segs.length - 1) {
      node.children.push(item);
    } else {
      const existing = node.children.find(
        (c): c is SkillGroupNode => c.kind === "group" && c.name === seg,
      );
      if (existing) {
        node = existing;
      } else {
        const groupTreePath = segs.slice(0, i + 1).join("/");
        const groupDir = join(meta.dir, groupTreePath);
        const group: SkillGroupNode = {
          kind: "group",
          id: `${meta.dir}::${groupTreePath}`,
          sourceRoot: meta.dir,
          ruleBaseDir: meta.baseDir,
          ruleBaseRelativePath: toPosix(relative(meta.baseDir, groupDir)),
          name: seg,
          scope: meta.scope,
          source: meta.source,
          state: "all-off",
          ambiguous: false,
          children: [],
        };
        node.children.push(group);
        node = group;
      }
    }
  }
  if (segs.length === 0) node.children.push(item);
}

function annotateTree(
  node: { children: SkillChild[] } & Partial<SkillGroupNode>,
  groupPathRoots: Map<string, Set<string>>,
): { total: number; enabled: number } {
  let total = 0;
  let enabled = 0;
  for (const c of node.children) {
    if (c.kind === "group") {
      const childCounts = annotateTree(c, groupPathRoots);
      total += childCounts.total;
      enabled += childCounts.enabled;
      const key = `${c.scope}::${c.ruleBaseRelativePath}`;
      const set = groupPathRoots.get(key) ?? new Set<string>();
      set.add(c.sourceRoot);
      groupPathRoots.set(key, set);
    } else {
      total += 1;
      if (c.status === "enabled") enabled += 1;
    }
  }
  if (node.kind === "group") {
    node.state =
      total === 0 ? "all-off" : enabled === total ? "all-on" : enabled === 0 ? "all-off" : "mixed";
  }
  return { total, enabled };
}

function markGroupAmbiguity(
  node: { children: SkillChild[] },
  groupPathRoots: Map<string, Set<string>>,
): boolean {
  let anyAmbiguous = false;
  for (const c of node.children) {
    if (c.kind === "group") {
      const childAmbiguous = markGroupAmbiguity(c, groupPathRoots);
      c.ambiguous =
        (groupPathRoots.get(`${c.scope}::${c.ruleBaseRelativePath}`)?.size ?? 0) > 1 ||
        childAmbiguous;
      if (c.ambiguous) anyAmbiguous = true;
    } else if (c.ambiguous) {
      anyAmbiguous = true;
    }
  }
  return anyAmbiguous;
}

function sortTree(node: { children: SkillChild[] }): void {
  node.children.sort((a, b) => {
    const aSkill = a.kind === "skill";
    const bSkill = b.kind === "skill";
    if (aSkill !== bSkill) return aSkill ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of node.children) if (c.kind === "group") sortTree(c);
}

export function buildSkillInventory(opts: BuildSkillInventoryOptions): SkillInventory {
  const globalSettingsPath = join(opts.agentDir, "settings.json");
  const projectSettingsPath = join(opts.cwd, CONFIG_DIR_NAME, "settings.json");
  const settingsPath = settingsPathFor(opts.scope, opts);
  const diagnostics: SkillDiagnostic[] = [];

  const globalSettings = readSettingsSkills(globalSettingsPath);
  if (globalSettings.parseError)
    diagnostics.push({ path: globalSettingsPath, message: globalSettings.parseError });
  const trusted = Boolean(opts.projectTrusted);
  const projectSettingsRaw = trusted
    ? readSettingsSkills(projectSettingsPath)
    : { skills: [] as string[] };
  if (trusted && projectSettingsRaw.parseError) {
    diagnostics.push({
      path: projectSettingsPath,
      message: projectSettingsRaw.parseError as string,
    });
  }
  const scopeSettings = opts.scope === "global" ? globalSettings : projectSettingsRaw;
  const customRules = scopeSettings.skills.filter((s) => isPlainGlob(s)).map((s) => toPosix(s));

  const roots: DiscoveredRoot[] = [...globalRoots(opts, globalSettings.skills)];
  if (trusted) roots.push(...projectRoots(opts, projectSettingsRaw.skills));

  const discoveredRoots = roots.map((r) => r.dir).filter((d) => existsSync(d));
  if (opts.scope === "project" && !trusted) {
    for (const p of projectRootPaths(opts)) discoveredRoots.push(p);
  }

  const settingsForRoot = (root: DiscoveredRoot): string[] =>
    root.scope === "user" ? globalSettings.skills : projectSettingsRaw.skills;

  const rawSkills: RawSkill[] = [];
  for (const root of roots) {
    for (const s of discoverSkillsFromRoot(root, diagnostics)) rawSkills.push(s);
  }

  type Resolved = { raw: RawSkill; enabled: boolean; matching: string[] };
  const resolved: Resolved[] = rawSkills.map((raw) => {
    const ctx = buildMatchContext(raw.filePath, raw.root.baseDir);
    const { enabled, matched } = isEnabledByOverrides(ctx, settingsForRoot(raw.root));
    return { raw, enabled, matching: matched };
  });

  resolved.sort((a, b) => {
    const ra = precedenceRank(a.raw.root.scope, a.raw.root.source);
    const rb = precedenceRank(b.raw.root.scope, b.raw.root.source);
    return ra - rb;
  });

  const seenPath = new Set<string>();
  const items: SkillInventoryItem[] = [];
  const nameWinner = new Map<string, SkillInventoryItem>();
  for (const r of resolved) {
    if (seenPath.has(r.raw.canonicalPath)) continue;
    seenPath.add(r.raw.canonicalPath);
    const skillDir = dirname(r.raw.filePath);
    const ruleRelativeDir = toPosix(
      relative(r.raw.root.baseDir, r.raw.isConfiguredFile ? r.raw.filePath : skillDir),
    );
    const treePath = r.raw.isConfiguredFile ? "" : toPosix(relative(r.raw.root.dir, skillDir));
    const item: SkillInventoryItem = {
      kind: "skill",
      id: r.raw.canonicalPath,
      canonicalPath: r.raw.canonicalPath,
      name: r.raw.name,
      description: r.raw.description,
      enabled: r.enabled,
      status: r.enabled ? "enabled" : "disabled",
      ruleBaseDir: r.raw.root.baseDir,
      ruleRelativeDir,
      treePath,
      sourceRoot: r.raw.root.dir,
      scope: r.raw.root.scope,
      source: r.raw.root.source,
      matchingRules: r.matching,
      ambiguous: false,
    };
    items.push(item);
    if (r.enabled) {
      if (!nameWinner.has(r.raw.name)) nameWinner.set(r.raw.name, item);
    }
  }
  for (const item of items) {
    if (!item.enabled) continue;
    const winner = nameWinner.get(item.name);
    if (winner && winner.id !== item.id) {
      item.status = "shadowed";
      item.shadowedBy = { id: winner.id, canonicalPath: winner.canonicalPath, name: winner.name };
    }
  }

  const dirToRoots = new Map<string, Set<string>>();
  for (const it of items) {
    const dirKey = `${it.scope}::${it.ruleRelativeDir}`;
    const dirSet = dirToRoots.get(dirKey) ?? new Set<string>();
    dirSet.add(it.sourceRoot);
    dirToRoots.set(dirKey, dirSet);
  }
  for (const it of items) {
    if ((dirToRoots.get(`${it.scope}::${it.ruleRelativeDir}`)?.size ?? 0) > 1) it.ambiguous = true;
  }

  const itemsByRoot = new Map<string, SkillInventoryItem[]>();
  for (const it of items) {
    const arr = itemsByRoot.get(it.sourceRoot) ?? [];
    arr.push(it);
    itemsByRoot.set(it.sourceRoot, arr);
  }
  const rootMeta = new Map(roots.map((r) => [r.dir, r]));
  const builtRoots: SkillRoot[] = [];
  const groupPathRoots = new Map<string, Set<string>>();
  for (const [sourceRoot, rootItems] of itemsByRoot) {
    const meta = rootMeta.get(sourceRoot);
    if (!meta) continue;
    const tree: SkillRoot = {
      sourceRoot: meta.dir,
      ruleBaseDir: meta.baseDir,
      scope: meta.scope,
      source: meta.source,
      rootKind: detectRootKind(meta.dir, opts),
      children: [],
    };
    for (const it of rootItems) insertSkillIntoTree(tree, it, meta);
    annotateTree(tree, groupPathRoots);
    builtRoots.push(tree);
  }
  for (const tree of builtRoots) markGroupAmbiguity(tree, groupPathRoots);
  for (const tree of builtRoots) sortTree(tree);

  return {
    scope: opts.scope,
    settingsPath,
    trusted,
    roots: builtRoots,
    customRules,
    discoveredRoots,
    diagnostics,
  };
}

export async function mutateSkillEnabled(
  opts: MutateSkillEnabledOptions,
): Promise<SkillMutationResult> {
  return mutateSkillEnabledWithBuilder(opts, buildSkillInventory);
}
