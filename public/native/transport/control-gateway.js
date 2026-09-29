// Host control gateway: sends `host_request` frames over the native /v2/ws
// protocol and resolves the matching `host_response`. This is the write-capable
// counterpart to the read-only HostDataGateway — it covers package management
// and opening external links, which run the embedded `pi` CLI on the Rust host.
//
// Requests are correlated by a `host-` prefixed requestId; frames that don't
// match a pending request are ignored (other gateways share the same adapter).
import { randomId } from "../utils/random-id.js";

export class HostControlGateway {
  #adapter;
  #generation = 0;
  #pending = new Map();

  constructor(adapter) {
    this.#adapter = adapter;
    adapter.setReceiver((frame) => this.#receive(frame));
    adapter.setConnectionListener?.((connected) => {
      if (!connected) this.#disconnect();
    });
  }

  #request(operation, parameters = {}, { signal } = {}) {
    const requestId = `host-${randomId()}`;
    const generation = this.#generation;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Host request was cancelled", "AbortError"));
        return;
      }
      const pending = { resolve, reject, generation, signal, onAbort: null };
      if (signal) {
        pending.onAbort = () => {
          if (!this.#pending.delete(requestId)) return;
          signal.removeEventListener("abort", pending.onAbort);
          try {
            this.#adapter.send({
              type: "host_request",
              requestId: `host-${randomId()}`,
              operation: "cancel_workflow_code",
              executionRequestId: requestId,
            });
          } catch {
            // The socket may already be closing; host-side process lifetime is
            // still bounded and tied to the connection task.
          }
          reject(new DOMException("Host request was cancelled", "AbortError"));
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.#pending.set(requestId, pending);
      if (!this.#pending.has(requestId)) return;
      try {
        this.#adapter.send({
          type: "host_request",
          requestId,
          operation,
          ...parameters,
        });
      } catch (error) {
        this.#pending.delete(requestId);
        if (pending.onAbort) signal.removeEventListener("abort", pending.onAbort);
        reject(error);
      }
    });
  }

  async listPiPackages() {
    const frame = await this.#request("list_pi_packages");
    // List returns an array of package objects (source, scope, installedPath,
    // disabled, packageName, version, description).
    return Array.isArray(frame?.packages) ? frame.packages : [];
  }

  async checkPiPackageUpdates(workspaceId) {
    const frame = await this.#request("check_pi_package_updates", { workspaceId });
    // Only packages with an actual update are reported (source/scope/available).
    return Array.isArray(frame?.updates) ? frame.updates : [];
  }

  async installPiPackage(source, { local = false } = {}) {
    await this.#request("install_pi_package", { source, local });
  }

  async removePiPackage(source, { local = false } = {}) {
    await this.#request("remove_pi_package", { source, local });
  }

  async updatePiPackage(source = "") {
    await this.#request("update_pi_package", { source });
  }

  async setPiPackageDisabled(source, scope, disabled, cwd = "") {
    const frame = await this.#request("set_pi_package_disabled", {
      source,
      scope,
      disabled,
      cwd,
    });
    return Boolean(frame?.changed);
  }

  async restartRuntime(workspaceId, sessionId) {
    const frame = await this.#request("restart_runtime", { workspaceId, sessionId });
    return frame?.instanceId ?? null;
  }

  // Spawns an external ACP agent (agentId defaults to "claude-code") as a
  // scoped subagent for one task. The session's Pi backend is untouched; the
  // returned throwaway {workspaceId, sessionId, instanceId} target is driven
  // with `acp_prompt` runtime requests and retired with `stopAcpTask()`.
  async startAcpTask(workspaceId, sessionId, agentId = "claude-code") {
    const frame = await this.#request("acp_task_start", {
      workspaceId,
      sessionId,
      agentId,
    });
    if (!frame?.target) throw new Error("Host returned no target for the ACP subagent task");
    return frame.target;
  }

  // Tears down a subagent task runtime once its run settles. Best effort — a
  // run whose process already exited resolves without error.
  async stopAcpTask(target) {
    await this.#request("acp_task_stop", { target });
  }

  // ACP subagents whose underlying CLI is installed locally ({id, label}[]).
  // The composer's `#` picker only offers these.
  async listAcpAgents() {
    const frame = await this.#request("acp_list_agents");
    return Array.isArray(frame?.agents) ? frame.agents : [];
  }

  async resolveWorkspace(projectPath) {
    const frame = await this.#request("resolve_workspace", { projectPath });
    if (!frame?.workspaceId) throw new Error("Host returned an invalid workspace id");
    return frame.workspaceId;
  }

  async loadWorkflow(workflowId, workspaceId) {
    const frame = await this.#request("load_workflow", { workflowId, workspaceId });
    return frame?.record ?? null;
  }

  async createWorkflow(workflow) {
    const frame = await this.#request("create_workflow", { workflow });
    return Boolean(frame?.created);
  }

  async compareAndSwapWorkflow({
    workflowId,
    workspaceId,
    expectedRevision,
    workflow,
    event,
    expectedCatalogRevision,
  }) {
    const frame = await this.#request("compare_and_swap_workflow", {
      workflowId,
      workspaceId,
      expectedRevision,
      workflow,
      event,
      ...(expectedCatalogRevision ? { expectedCatalogRevision } : {}),
    });
    return Boolean(frame?.saved);
  }

  async createWorkflowRun(run) {
    const frame = await this.#request("create_workflow_run", { run });
    return Boolean(frame?.created);
  }

  async loadWorkflowRun(runId, workspaceId) {
    const frame = await this.#request("load_workflow_run", { workflowId: runId, workspaceId });
    return frame?.record ?? null;
  }

  async listWorkflowRuns(workflowId, workspaceId) {
    const frame = await this.#request("list_workflow_runs", { workflowId, workspaceId });
    return Array.isArray(frame?.runs) ? frame.runs : [];
  }

  async appendWorkflowRunEvent({ runId, workspaceId, expectedSequence, run, event }) {
    const frame = await this.#request("append_workflow_run_event", {
      workflowId: runId,
      workspaceId,
      expectedSequence,
      run,
      event,
    });
    return Boolean(frame?.saved);
  }

  async getWorkflowExecutionCapabilities() {
    const frame = await this.#request("get_workflow_execution_capabilities");
    return { codeExecution: frame?.codeExecution === true };
  }

  async executeWorkflowCode({ runId, workspaceId, nodeId, inputs, signal }) {
    const frame = await this.#request(
      "execute_workflow_code",
      {
        runId,
        workspaceId,
        nodeId,
        inputs,
      },
      { signal },
    );
    if (!frame || !Array.isArray(frame.logs) || !Object.hasOwn(frame, "output"))
      throw new Error("Host returned an invalid workflow code result");
    return { output: frame.output, logs: frame.logs };
  }

  async listWorkflowNodeTemplates(workspaceId) {
    const frame = await this.#request("list_workflow_node_templates", { workspaceId });
    if (!Array.isArray(frame?.templates) || typeof frame.catalogRevision !== "string")
      throw new Error("Host returned an invalid workflow node catalog");
    return {
      templates: frame.templates,
      catalogRevision: frame.catalogRevision,
    };
  }

  async createWorkflowNodeTemplate(workspaceId, meta, expectedCatalogRevision) {
    const frame = await this.#request("create_workflow_node_template", {
      workspaceId,
      meta,
      expectedCatalogRevision,
    });
    return { created: Boolean(frame?.created), catalogRevision: frame?.catalogRevision ?? null };
  }

  async listInstalledApps() {
    const frame = await this.#request("list_installed_apps");
    return Array.isArray(frame?.apps) ? frame.apps : [];
  }

  async openInApp(path, { appName = null, command = null } = {}) {
    await this.#request("open_in_app", { path, appName, command });
  }

  async openExternal(url) {
    await this.#request("open_external", { url });
  }

  // Permanently deletes saved sessions (by id) from disk. Best effort: the
  // response's `errors` lists ids that could not be removed; callers should
  // only drop successfully-deleted ids from local state.
  async deleteSessions(sessionIds) {
    const frame = await this.#request("delete_sessions", { sessionIds });
    return {
      deleted: Array.isArray(frame?.deleted) ? frame.deleted : [],
      errors: Array.isArray(frame?.errors) ? frame.errors : [],
    };
  }

  // Skills install flow: pick a local source directory, scan it for skill
  // candidates, then link selected candidates into Pi's settings.json.
  async pickSkillSource(workspaceId) {
    return this.#request("pick_skill_source", { workspaceId });
  }

  async scanSkillInstallSource(sourceId, workspaceId) {
    return this.#request("skill_scan_install_source", { sourceId, workspaceId });
  }

  async installSkillLinks(request) {
    return this.#request("skill_install_links", request);
  }

  #receive(frame) {
    const pending = this.#pending.get(frame?.requestId);
    if (!pending || pending.generation !== this.#generation) return;
    this.#pending.delete(frame.requestId);
    if (pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    if (frame.error) pending.reject(new Error(frame.error.message ?? String(frame.error)));
    else pending.resolve(frame);
  }

  #disconnect() {
    this.#generation += 1;
    for (const pending of this.#pending.values()) {
      if (pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
      pending.reject(new Error("Host disconnected before the control request completed"));
    }
    this.#pending.clear();
  }
}
