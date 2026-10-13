// ABOUTME: Package source parsing (npm/git/local), identity, install-root resolution, and settings deduplication.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import hostedGitInfo from "hosted-git-info";
import type { SkillDiagnostic, SkillScope } from "./skill-inventory.ts";

export const CONFIG_DIR_NAME = ".pi";

export type ParsedPackageSource =
  | { type: "npm"; spec: string; name: string; version?: string; range?: string; pinned: boolean }
  | {
      type: "git";
      repo: string;
      host: string;
      path: string;
      ref?: string;
      pinned: boolean;
    }
  | { type: "local"; path: string };

export type ConfiguredPackageEntry = {
  source: string;
  /** True when the entry is an `autoload:false` delta; false otherwise. */
  autoload: boolean;
};

export type ResolvedPackage = {
  parsed: ParsedPackageSource;
  identity: string;
  /** Display/effective scope of this entry. */
  scope: SkillScope;
  /** Scope of the settings file that contributed the effective source. */
  sourceScope: SkillScope;
  /** The settings source string (for display). */
  source: string;
  /** True if this entry originated from an autoload:false delta. */
  autoload: boolean;
  /** Resolved install root, or undefined if not installed. */
  installedRoot?: string;
};

function isLocalPath(source: string): boolean {
  const trimmed = source.trim();
  return !(
    trimmed.startsWith("npm:") ||
    trimmed.startsWith("git:") ||
    trimmed.startsWith("github:") ||
    trimmed.startsWith("http:") ||
    trimmed.startsWith("https:") ||
    trimmed.startsWith("ssh:")
  );
}

function parseNpmSpec(spec: string): { name: string; version?: string } {
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  if (!match) return { name: spec };
  const name = match[1] ?? spec;
  const version = match[2];
  return { name, version };
}

export function parseGitUrl(source: string): {
  type: "git";
  repo: string;
  host: string;
  path: string;
  ref?: string;
  pinned: boolean;
} | null {
  const trimmed = source.trim();
  const hasGitPrefix = trimmed.startsWith("git:");
  const url = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;

  if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url)) {
    return null;
  }

  const split = splitRef(url);

  const hostedCandidates = [split.ref ? `${split.repo}#${split.ref}` : undefined, url].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of hostedCandidates) {
    const info = hostedGitInfo.fromUrl(candidate);
    if (info) {
      if (split.ref && info.project?.includes("@")) continue;
      const useHttpsPrefix =
        !split.repo.startsWith("http://") &&
        !split.repo.startsWith("https://") &&
        !split.repo.startsWith("ssh://") &&
        !split.repo.startsWith("git://") &&
        !split.repo.startsWith("git@");
      return buildGitSource({
        repo: useHttpsPrefix ? `https://${split.repo}` : split.repo,
        host: info.domain || "",
        path: `${info.user}/${info.project}`,
        ref: info.committish || split.ref || undefined,
      });
    }
  }

  const httpsCandidates = [
    split.ref ? `https://${split.repo}#${split.ref}` : undefined,
    `https://${url}`,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of httpsCandidates) {
    const info = hostedGitInfo.fromUrl(candidate);
    if (info) {
      if (split.ref && info.project?.includes("@")) continue;
      return buildGitSource({
        repo: `https://${split.repo}`,
        host: info.domain || "",
        path: `${info.user}/${info.project}`,
        ref: info.committish || split.ref || undefined,
      });
    }
  }

  return parseGenericGitUrl(url);
}

function splitRef(url: string): { repo: string; ref?: string } {
  const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    const pathWithMaybeRef = scpLikeMatch[2] ?? "";
    const refSeparator = pathWithMaybeRef.indexOf("@");
    if (refSeparator < 0) return { repo: url };
    const repoPath = pathWithMaybeRef.slice(0, refSeparator);
    const ref = pathWithMaybeRef.slice(refSeparator + 1);
    if (!repoPath || !ref) return { repo: url };
    return { repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath}`, ref };
  }

  if (url.includes("://")) {
    try {
      const parsed = new URL(url);
      const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
      const refSeparator = pathWithMaybeRef.indexOf("@");
      if (refSeparator < 0) return { repo: url };
      const repoPath = pathWithMaybeRef.slice(0, refSeparator);
      const ref = pathWithMaybeRef.slice(refSeparator + 1);
      if (!repoPath || !ref) return { repo: url };
      parsed.pathname = `/${repoPath}`;
      return { repo: parsed.toString().replace(/\/$/, ""), ref };
    } catch {
      return { repo: url };
    }
  }

  const slashIndex = url.indexOf("/");
  if (slashIndex < 0) return { repo: url };
  const host = url.slice(0, slashIndex);
  const pathWithMaybeRef = url.slice(slashIndex + 1);
  const refSeparator = pathWithMaybeRef.indexOf("@");
  if (refSeparator < 0) return { repo: url };
  const repoPath = pathWithMaybeRef.slice(0, refSeparator);
  const ref = pathWithMaybeRef.slice(refSeparator + 1);
  if (!repoPath || !ref) return { repo: url };
  return { repo: `${host}/${repoPath}`, ref };
}

function decodeForValidation(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function hasUnsafeGitInstallPart(value: string, allowSlash: boolean): boolean {
  const decoded = decodeForValidation(value);
  if (decoded === null) return true;
  const candidates = [value, decoded];
  for (const candidate of candidates) {
    if (candidate.includes("\0") || candidate.includes("\\") || candidate.startsWith("/")) {
      return true;
    }
    if (!allowSlash && candidate.includes("/")) return true;
    if (candidate.split("/").includes("..")) return true;
  }
  return false;
}

function buildGitSource(args: { repo: string; host: string; path: string; ref?: string }): {
  type: "git";
  repo: string;
  host: string;
  path: string;
  ref?: string;
  pinned: boolean;
} | null {
  if (args.path.startsWith("/")) return null;
  const normalizedPath = args.path.replace(/\.git$/, "").replace(/^\/+/, "");
  if (!args.host || !normalizedPath || normalizedPath.split("/").length < 2) return null;
  if (hasUnsafeGitInstallPart(args.host, false) || hasUnsafeGitInstallPart(normalizedPath, true)) {
    return null;
  }
  return {
    type: "git",
    repo: args.repo,
    host: args.host,
    path: normalizedPath,
    ref: args.ref,
    pinned: args.ref !== undefined,
  };
}

function parseGenericGitUrl(url: string): {
  type: "git";
  repo: string;
  host: string;
  path: string;
  ref?: string;
  pinned: boolean;
} | null {
  const { repo: repoWithoutRef, ref } = splitRef(url);
  let repo = repoWithoutRef;
  let host = "";
  let path = "";

  const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    host = scpLikeMatch[1] ?? "";
    path = scpLikeMatch[2] ?? "";
  } else if (
    repoWithoutRef.startsWith("https://") ||
    repoWithoutRef.startsWith("http://") ||
    repoWithoutRef.startsWith("ssh://") ||
    repoWithoutRef.startsWith("git://")
  ) {
    try {
      const parsed = new URL(repoWithoutRef);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  } else {
    const slashIndex = repoWithoutRef.indexOf("/");
    if (slashIndex < 0) return null;
    host = repoWithoutRef.slice(0, slashIndex);
    path = repoWithoutRef.slice(slashIndex + 1);
    if (!host.includes(".") && host !== "localhost") return null;
    repo = `https://${repoWithoutRef}`;
  }

  return buildGitSource({ repo, host, path, ref });
}

export function parsePackageSource(source: string): ParsedPackageSource {
  if (source.startsWith("npm:")) {
    const spec = source.slice("npm:".length).trim();
    const { name, version } = parseNpmSpec(spec);
    return { type: "npm", spec, name, version, pinned: false };
  }
  if (isLocalPath(source)) {
    return { type: "local", path: source };
  }
  const git = parseGitUrl(source);
  if (git) return git;
  return { type: "local", path: source };
}

export function packageIdentity(parsed: ParsedPackageSource): string {
  if (parsed.type === "npm") return `npm:${parsed.name}`;
  if (parsed.type === "git") return `git:${parsed.host}/${parsed.path}`;
  return `local:${parsed.path}`;
}

export function resolveInstalledPackageRoot(
  parsed: ParsedPackageSource,
  scope: SkillScope,
  options: { agentDir: string; cwd: string },
): string {
  if (parsed.type === "npm") {
    return scope === "global"
      ? join(options.agentDir, "npm", "node_modules", parsed.name)
      : join(options.cwd, CONFIG_DIR_NAME, "npm", "node_modules", parsed.name);
  }
  if (parsed.type === "git") {
    const installRoot =
      scope === "global"
        ? join(options.agentDir, "git")
        : join(options.cwd, CONFIG_DIR_NAME, "git");
    return resolveManagedPath(installRoot, parsed.host, parsed.path);
  }
  const p = expandLocalPath(parsed.path);
  if (isAbsolute(p)) return resolve(p);
  const base = scope === "global" ? options.agentDir : join(options.cwd, CONFIG_DIR_NAME);
  return resolve(base, p);
}

function expandLocalPath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

function resolveManagedPath(root: string, ...parts: string[]): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, ...parts);
  if (!isWithinPackage(resolvedPath, resolvedRoot)) {
    throw new Error(`Refusing to use path outside package install root: ${resolvedPath}`);
  }
  return resolvedPath;
}

export function isWithinPackage(path: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

type RawSettings = { packages?: unknown };

export function readSettingsPackagesWithDiags(
  settingsPath: string,
  diagnostics: SkillDiagnostic[],
): ConfiguredPackageEntry[] {
  if (!existsSync(settingsPath)) return [];
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "invalid JSON";
    diagnostics.push({ path: settingsPath, message: `Pi settings must be valid JSON: ${msg}` });
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    diagnostics.push({ path: settingsPath, message: "Pi settings must be a JSON object" });
    return [];
  }
  const packages = (parsed as RawSettings).packages;
  if (!Array.isArray(packages)) return [];
  const entries: ConfiguredPackageEntry[] = [];
  let malformed = 0;
  for (const raw of packages) {
    if (typeof raw === "string") {
      entries.push({ source: raw, autoload: false });
      continue;
    }
    if (raw !== null && typeof raw === "object") {
      const obj = raw as { source?: unknown; autoload?: unknown };
      if (typeof obj.source === "string") {
        entries.push({ source: obj.source, autoload: obj.autoload === false });
        continue;
      }
    }
    malformed += 1;
  }
  if (malformed > 0) {
    diagnostics.push({
      path: settingsPath,
      message: `${malformed} malformed package entr${malformed === 1 ? "y" : "ies"} skipped`,
    });
  }
  return entries;
}

export function dedupeConfiguredPackages(
  globalEntries: ConfiguredPackageEntry[],
  projectEntries: ConfiguredPackageEntry[],
  options: { agentDir: string; cwd: string; projectTrusted: boolean },
): ResolvedPackage[] {
  function dedupeSameScope(resolved: ResolvedPackage[]): ResolvedPackage[] {
    const seen = new Set<string>();
    const out: ResolvedPackage[] = [];
    for (const r of resolved) {
      if (seen.has(r.identity)) continue;
      seen.add(r.identity);
      out.push(r);
    }
    return out;
  }

  const resolveEntry = (entry: ConfiguredPackageEntry, scope: SkillScope): ResolvedPackage => {
    const parsed = parsePackageSource(entry.source);
    const identity = packageIdentity(parsed);
    let installedRoot: string | undefined;
    try {
      const root = resolveInstalledPackageRoot(parsed, scope, options);
      installedRoot = existsSync(root) && statSync(root).isDirectory() ? root : undefined;
    } catch {
      installedRoot = undefined;
    }
    return {
      parsed,
      identity,
      scope,
      sourceScope: scope,
      source: entry.source,
      autoload: entry.autoload,
      installedRoot,
    };
  };

  const resolvedGlobal = dedupeSameScope(globalEntries.map((e) => resolveEntry(e, "global")));
  if (!options.projectTrusted) return resolvedGlobal;

  const resolvedProject = dedupeSameScope(projectEntries.map((e) => resolveEntry(e, "project")));
  const globalByIdentity = new Map(resolvedGlobal.map((r) => [r.identity, r]));
  const result: ResolvedPackage[] = [];
  const seenIdentities = new Set<string>();

  for (const proj of resolvedProject) {
    if (seenIdentities.has(proj.identity)) continue;
    seenIdentities.add(proj.identity);
    const matchingGlobal = globalByIdentity.get(proj.identity);
    if (proj.autoload && matchingGlobal) {
      result.push({
        ...matchingGlobal,
        scope: "project",
        sourceScope: "global",
        source: proj.source,
        autoload: true,
      });
    } else {
      result.push(proj);
    }
  }
  for (const glob of resolvedGlobal) {
    if (seenIdentities.has(glob.identity)) continue;
    seenIdentities.add(glob.identity);
    result.push(glob);
  }
  return result;
}
