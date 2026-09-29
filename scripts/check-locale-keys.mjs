/**
 * Fail if public/locales/*.json do not share the same leaf key set.
 *
 * Adding a string in one language without the matching keys in every other
 * locale file is a lint error. Nested objects are compared by dotted path
 * (sidebar.rename === "sidebar.rename").
 *
 * Run:  node scripts/check-locale-keys.mjs
 * Exit: 0 = all locales match, 1 = missing keys or invalid JSON
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function flattenKeys(obj, prefix = "") {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return prefix ? [prefix] : [];
  }
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...flattenKeys(value, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

export function listLocaleFiles(localesDir) {
  return readdirSync(localesDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

export function loadLocale(localesDir, filename) {
  const filePath = join(localesDir, filename);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${filename}: invalid JSON (${error.message})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filename}: root value must be a JSON object`);
  }
  return parsed;
}

/**
 * Compare leaf-key sets across locales.
 * @returns {{ unionSize: number, reports: Array<{ file: string, missing: string[] }> }}
 */
export function diffLocaleKeys(locales) {
  const union = new Set();
  for (const locale of locales) {
    for (const key of locale.keys) union.add(key);
  }
  const reports = [];
  for (const locale of locales) {
    const missing = [...union].filter((key) => !locale.keys.has(key)).sort();
    if (missing.length > 0) {
      reports.push({ file: locale.file, missing });
    }
  }
  return { unionSize: union.size, reports };
}

export function checkLocaleKeys(localesDir) {
  const files = listLocaleFiles(localesDir);
  if (files.length === 0) {
    throw new Error(`no *.json files in ${localesDir}`);
  }
  const locales = files.map((file) => {
    const messages = loadLocale(localesDir, file);
    return { file, keys: new Set(flattenKeys(messages)) };
  });
  return { files, ...diffLocaleKeys(locales) };
}

function formatReport({ files, unionSize, reports }) {
  const names = files.map((file) => file.replace(/\.json$/, "")).join(", ");
  const header = `Checking locale key parity (${files.length} files, ${unionSize} keys): ${names}`;
  if (reports.length === 0) {
    return { ok: true, text: `${header}\n✓ all locale files share ${unionSize} keys\n` };
  }
  const lines = [header, ""];
  for (const { file, missing } of reports) {
    lines.push(`✗ ${file} missing ${missing.length} key(s):`);
    for (const key of missing) {
      lines.push(`    ${key}`);
    }
  }
  lines.push("");
  lines.push("Locale files must share the same keys. Add the missing keys above.");
  lines.push("");
  return { ok: false, text: `${lines.join("\n")}\n` };
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === resolve(entry);
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const localesDir = join(root, "public", "locales");
  let result;
  try {
    result = checkLocaleKeys(localesDir);
  } catch (error) {
    console.error(`✗ locale key check failed: ${error.message}`);
    process.exit(1);
  }
  const { ok, text } = formatReport(result);
  if (ok) {
    process.stdout.write(text);
    process.exit(0);
  }
  process.stderr.write(text);
  process.exit(1);
}

if (isDirectRun()) {
  main();
}
