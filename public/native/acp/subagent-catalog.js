export const SUBAGENTS = [
  {
    id: "claude-code",
    token: "claude",
    label: "Claude Code",
    description: "Delegate a task via ACP",
  },
  { id: "gemini", token: "gemini", label: "Gemini CLI", description: "Delegate a task via ACP" },
  { id: "codex", token: "codex", label: "Codex", description: "Delegate a task via ACP" },
  { id: "cursor", token: "cursor", label: "Cursor", description: "Delegate a task via ACP" },
  { id: "qwen", token: "qwen", label: "Qwen Code", description: "Delegate a task via ACP" },
];

const SUBAGENT_LINE = /^[#/]([a-z][a-z0-9-]*)[ \t]+([\s\S]+)$/;
const SUBAGENT_TOKEN_ONLY = /^[#/]([a-z][a-z0-9-]*)\s*$/;

export function knownSubagent(token) {
  return SUBAGENTS.find((entry) => entry.token === token || entry.id === token) ?? null;
}

/**
 * 解析输入行是否委派给已知 ACP 子代理（如 `#claude <task>` 或 `/codex <task>`）。
 * 若仅输入触发词但缺少任务描述，返回 `{ agent, incomplete: true }`。
 */
export function parseSubagentTask(value) {
  const text = String(value ?? "").trimStart();
  const match = SUBAGENT_LINE.exec(text);
  if (match) {
    const agent = knownSubagent(match[1]);
    const task = match[2].trim();
    if (agent && task) return { agent, task };
  }
  const tokenOnly = SUBAGENT_TOKEN_ONLY.exec(text);
  const agent = tokenOnly && knownSubagent(tokenOnly[1]);
  if (agent) return { agent, incomplete: true };
  return null;
}

/**
 * 创建懒探测本机已安装 ACP 子代理 CLI 的目录实例。
 * 远程 SSH 工作区不具备本地检出目录，始终返回空列表。
 */
export function createSubagentCatalog({ control, isSshRemoteActive }) {
  let detectedSubagentIds = null;
  let detectingSubagents = false;

  function ensureSubagentDetection() {
    if (detectedSubagentIds || detectingSubagents) return;
    detectingSubagents = true;
    control
      .listAcpAgents()
      .then((agents) => {
        detectedSubagentIds = new Set((agents ?? []).map((agent) => agent.id));
      })
      .catch(() => {
        // 探测失败时保留完整候选列表，由运行卡片在缺少 CLI 时展示具体原因
      })
      .finally(() => {
        detectingSubagents = false;
      });
  }

  return {
    getAgents() {
      if (isSshRemoteActive?.()) return [];
      ensureSubagentDetection();
      return detectedSubagentIds
        ? SUBAGENTS.filter((agent) => detectedSubagentIds.has(agent.id))
        : SUBAGENTS;
    },
    parseTask: parseSubagentTask,
  };
}
