// ABOUTME: Formats a workflow snapshot as language-aware Pi conversation context.

export function formatWorkflowChatContext(summary, translate) {
  if (!summary || typeof summary !== "object" || typeof translate !== "function") return "";
  const introduction = translate("workflow.chatContextPrompt", {
    revision: summary.revision ?? "?",
  });
  return `${introduction}\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``;
}
