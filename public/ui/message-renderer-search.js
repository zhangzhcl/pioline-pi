// ABOUTME: DOM text-node search highlighting utilities for chat messages.

export function escapeSearchRegExp(text) {
  return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function clearMessageSearchHighlights(container) {
  if (!container) return;
  const marks = container.querySelectorAll("mark[data-search-highlight='true']");
  if (marks.length === 0) return;
  const parentsToNormalize = new Set();
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    const text = document.createTextNode(mark.textContent || "");
    mark.replaceWith(text);
    if (parent) parentsToNormalize.add(parent);
  });
  for (const parent of parentsToNormalize) {
    parent.normalize();
  }
}

export function highlightTextNodeWithPattern(node, pattern, onMatch) {
  const text = node.textContent || "";
  const regex = new RegExp(pattern.source, pattern.flags);
  let lastIndex = 0;
  let matchCount = 0;
  let match = regex.exec(text);
  if (!match) return 0;

  const fragment = document.createDocumentFragment();
  while (match) {
    const [matchedText] = match;
    const start = match.index;
    if (start > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)));
    }

    const mark = document.createElement("mark");
    mark.dataset.searchHighlight = "true";
    mark.textContent = matchedText;
    fragment.appendChild(mark);
    if (typeof onMatch === "function") onMatch(mark);

    matchCount += 1;
    lastIndex = start + matchedText.length;
    match = regex.exec(text);
  }

  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  node.replaceWith(fragment);
  return matchCount;
}

export function highlightContainerSearchQuery(
  container,
  query,
  { scrollToFirst = true, highlightNode = highlightTextNodeWithPattern } = {},
) {
  clearMessageSearchHighlights(container);
  if (!container) return 0;

  const normalizedQuery = typeof query === "string" ? query.trim() : "";
  if (!normalizedQuery) return 0;

  const pattern = new RegExp(escapeSearchRegExp(normalizedQuery), "gi");
  let matchCount = 0;
  let firstMatch = null;

  container.querySelectorAll(".message-content").forEach((content) => {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest("mark[data-search-highlight='true']")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
      textNodes.push(currentNode);
      currentNode = walker.nextNode();
    }

    textNodes.forEach((node) => {
      const count = highlightNode(node, pattern, (mark) => {
        if (!firstMatch) firstMatch = mark;
      });
      matchCount += count;
    });
  });

  if (scrollToFirst && firstMatch && typeof firstMatch.scrollIntoView === "function") {
    firstMatch.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  return matchCount;
}
