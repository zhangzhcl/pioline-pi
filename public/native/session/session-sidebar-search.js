// 会话侧边栏：本地标题过滤与服务端全文检索结果渲染。

import { t } from "../../i18n.js";
import { createIcon } from "../../icons.js";
import { formatSessionTime } from "./session-sidebar-storage.js";

export function renderSidebarSearchResults(sidebar) {
  if (!sidebar._searchResults || sidebar._searchResults.length === 0) return;
  sidebar.container.querySelector(".search-results-group")?.remove();

  const group = document.createElement("div");
  group.className = "search-results-group";
  const header = document.createElement("div");
  header.className = "project-header search-results-header";
  const searchIcon = document.createElement("span");
  const iconNode = createIcon("search", { size: 13 });
  if (iconNode) searchIcon.appendChild(iconNode);
  const matchesLabel = document.createElement("span");
  matchesLabel.textContent = t("sidebar.messageMatches");
  const countBadge = document.createElement("span");
  countBadge.className = "project-count";
  countBadge.textContent = String(sidebar._searchResults.length);
  header.append(searchIcon, matchesLabel, countBadge);
  group.appendChild(header);

  const sessionsDiv = document.createElement("div");
  sessionsDiv.className = "project-sessions";
  for (const result of sidebar._searchResults) {
    const item = document.createElement("div");
    item.className = "session-item search-result-item";
    item.dataset.sessionId = result.sessionId;
    if (result.sessionId === sidebar.activeSessionId) item.classList.add("active");
    const title = result.sessionName || result.firstMessage || t("sidebar.untitled");
    const snippet = result.matches?.[0]?.snippet || "";
    const matchCount = result.matches?.length ?? 0;
    const time = formatSessionTime(result.sessionTimestamp);
    const titleRow = document.createElement("div");
    titleRow.className = "session-title-row";
    const titleElement = document.createElement("div");
    titleElement.className = "session-title";
    titleElement.title = title;
    titleElement.textContent = title;
    titleRow.appendChild(titleElement);
    item.appendChild(titleRow);

    const snippetEl = document.createElement("div");
    snippetEl.className = "search-snippet";
    snippetEl.textContent = snippet;
    item.appendChild(snippetEl);

    const metaEl = document.createElement("div");
    metaEl.className = "session-meta";
    metaEl.textContent =
      matchCount > 1 ? `${time} · ${t("sidebar.matchCount", { count: matchCount })}` : time;
    item.appendChild(metaEl);

    item.addEventListener("click", () =>
      sidebar.onSelect({ id: result.sessionId, isCurrentWorkspace: true }),
    );
    sessionsDiv.appendChild(item);
  }
  group.appendChild(sessionsDiv);
  sidebar.container.insertBefore(group, sidebar.container.firstChild);
}

export async function runFullTextSidebarSearch(sidebar, query) {
  if (query !== sidebar.searchQuery) return;
  const workspaceId = sidebar.getTarget()?.workspaceId;
  if (!workspaceId) return;
  try {
    const response = await sidebar.data.searchSessions(workspaceId, query);
    if (query !== sidebar.searchQuery) return;
    sidebar._searchResults = response.results ?? [];
    renderSidebarSearchResults(sidebar);
  } catch (error) {
    console.error("[Sidebar] Search failed:", error);
  }
}

export function applySidebarSearchFilter(sidebar) {
  if (!sidebar.searchQuery) {
    sidebar.container.querySelectorAll(".session-item").forEach((el) => {
      el.classList.remove("hidden");
    });
    sidebar.container
      .querySelectorAll(".favourites-group, .project-group, .archived-group")
      .forEach((el) => {
        el.style.display = "";
      });
    sidebar.container.querySelector(".search-results-group")?.remove();
    return;
  }
  sidebar.container
    .querySelectorAll(".favourites-group, .project-group, .archived-group")
    .forEach((group) => {
      let hasVisible = false;
      group.querySelectorAll(".session-item").forEach((item) => {
        const title = (item.querySelector(".session-title")?.textContent || "").toLowerCase();
        const matches = title.includes(sidebar.searchQuery);
        item.classList.toggle("hidden", !matches);
        if (matches) hasVisible = true;
      });
      group.style.display = hasVisible ? "" : "none";
    });
}
