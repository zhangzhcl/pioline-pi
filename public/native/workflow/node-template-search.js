// ABOUTME: Ranks workflow node templates against a bounded Agent capability query.

import { localizeNodeMeta } from "./node-meta-localization.js";

const TOKEN_SPLIT_RE = /[\s.,;:!?/\\|()[\]{}"'`，。；：！？、]+/;

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase();
}

function queryTerms(query) {
  const terms = new Set(
    normalize(query)
      .split(TOKEN_SPLIT_RE)
      .map((term) => term.trim())
      .filter(Boolean),
  );
  for (const term of [...terms]) {
    const characters = Array.from(term);
    if (characters.length < 2 || !characters.some((character) => character.codePointAt(0) > 0x024f))
      continue;
    for (let index = 0; index < characters.length - 1; index += 1)
      terms.add(`${characters[index]}${characters[index + 1]}`);
  }
  return [...terms];
}

function templateSearchText(meta) {
  const localized = localizeNodeMeta(meta);
  const text = [
    meta.id,
    meta.type,
    meta.label,
    meta.description,
    localized.label,
    localized.description,
    ...(localized.inputs ?? []).flatMap((port) => [port.name, port.label]),
    ...(localized.outputs ?? []).flatMap((port) => [port.name, port.label]),
    ...(localized.params ?? []).flatMap((param) => [
      param.name,
      param.label,
      param.description,
      ...(param.options ?? []).flatMap((option) => [option.value, option.label]),
    ]),
    ...Object.values(meta.i18n ?? {}).flatMap((entry) => [
      entry.label,
      entry.description,
      ...Object.values(entry.inputs ?? {}),
      ...Object.values(entry.outputs ?? {}),
      ...Object.values(entry.params ?? {}).flatMap((param) => [
        param.label,
        param.description,
        ...Object.values(param.options ?? {}),
      ]),
    ]),
  ];
  return text.filter((value) => typeof value === "string").map(normalize);
}

function scoreTemplate(meta, query, terms) {
  const localized = localizeNodeMeta(meta);
  const label = normalize(localized.label);
  const identity = normalize(`${meta.id} ${meta.type}`);
  const text = templateSearchText(meta);
  let score = 0;
  if (label === query) score += 100;
  else if (label.includes(query)) score += 70;
  if (identity.includes(query)) score += 50;
  let matchedTerms = 0;
  for (const term of terms) {
    if (label.includes(term)) {
      score += 18;
      matchedTerms += 1;
    } else if (identity.includes(term)) {
      score += 12;
      matchedTerms += 1;
    } else if (text.some((value) => value.includes(term))) {
      score += 6;
      matchedTerms += 1;
    }
  }
  if (matchedTerms === terms.length) score += 10;
  return score;
}

export function searchNodeTemplateMetas(nodeMetas, query, { limit = 8 } = {}) {
  const normalizedQuery = normalize(typeof query === "string" ? query.trim() : "");
  if (!normalizedQuery) return { matches: [], totalMatches: 0 };
  const terms = queryTerms(normalizedQuery);
  const ranked = [...nodeMetas.values()]
    .filter((meta) => meta.catalogHidden !== true)
    .map((meta) => ({ meta, score: scoreTemplate(meta, normalizedQuery, terms) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.meta.id.localeCompare(right.meta.id));
  return {
    totalMatches: ranked.length,
    matches: ranked.slice(0, limit).map(({ meta }) => meta),
  };
}
