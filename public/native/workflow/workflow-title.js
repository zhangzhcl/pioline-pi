const DEFAULT_WORKFLOW_NAMES = new Set(["Workflow", "工作流", "Flujo de trabajo", "ワークフロー"]);

export function displayWorkflowName(name, translate) {
  if (DEFAULT_WORKFLOW_NAMES.has(name) && typeof translate === "function") {
    const localizedName = translate("workflow.defaultName");
    if (typeof localizedName === "string" && localizedName.length > 0) return localizedName;
  }
  return name;
}
