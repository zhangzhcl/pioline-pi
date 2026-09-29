// ABOUTME: Builds a read-only DAG from the official Pi subagent extension's
// tool lifecycle and structured partial results. Ordinary tools are ignored.

const TOOL_NAME = "subagent";
const MAX_INVOCATIONS = 20;
const MAX_TASK_TEXT = 4_000;

function shortText(value, limit = MAX_TASK_TEXT) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function taskSpecs(args) {
  if (typeof args?.agent === "string" && typeof args?.task === "string")
    return { mode: "single", tasks: [{ agent: args.agent, task: args.task }] };
  if (Array.isArray(args?.tasks)) return { mode: "parallel", tasks: args.tasks };
  if (Array.isArray(args?.chain)) return { mode: "chain", tasks: args.chain };
  return null;
}

function resultStatus(result, completed) {
  if (!completed && result?.exitCode === -1) return "running";
  if (!completed) return "running";
  if (result?.stopReason === "aborted") return "cancelled";
  if (result?.exitCode !== 0 || result?.stopReason === "error") return "error";
  return "success";
}

function resultSummary(result) {
  if (typeof result?.errorMessage === "string") return shortText(result.errorMessage, 600);
  if (typeof result?.stderr === "string" && result.stderr) return shortText(result.stderr, 600);
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content.find((part) => part?.type === "text")?.text;
    if (typeof text === "string" && text) return shortText(text, 600);
  }
  return "";
}

export class PiSubtaskObserver {
  #invocations = new Map();

  consume(event) {
    if (!event || typeof event !== "object") return false;
    if (event.type === "tool_execution_start" && event.toolName === TOOL_NAME)
      return this.#start(event);
    if (event.toolName !== TOOL_NAME || typeof event.toolCallId !== "string") return false;
    let invocation = this.#invocations.get(event.toolCallId);
    if (
      !invocation &&
      (event.type === "tool_execution_update" || event.type === "tool_execution_end")
    ) {
      this.#start({ ...event, type: "tool_execution_start" });
      invocation = this.#invocations.get(event.toolCallId);
    }
    if (!invocation) return false;
    if (event.type === "tool_execution_update") {
      this.#applyResults(invocation, event.partialResult?.details?.results, false);
      return true;
    }
    if (event.type === "tool_execution_end") {
      this.#applyResults(invocation, event.result?.details?.results, true);
      invocation.status =
        event.isError || invocation.tasks.some((task) => task.status === "error")
          ? "error"
          : invocation.tasks.some((task) => task.status === "cancelled")
            ? "cancelled"
            : "success";
      for (const task of invocation.tasks)
        if (task.status === "running" || task.status === "idle")
          task.status = event.isError ? "error" : "skipped";
      return true;
    }
    return false;
  }

  #start(event) {
    if (typeof event.toolCallId !== "string" || this.#invocations.has(event.toolCallId))
      return false;
    const spec = taskSpecs(event.args);
    if (!spec || spec.tasks.length === 0 || spec.tasks.length > 8) return false;
    if (this.#invocations.size >= MAX_INVOCATIONS) {
      const oldestComplete = [...this.#invocations].find(([, item]) => item.status !== "running");
      if (!oldestComplete) return false;
      this.#invocations.delete(oldestComplete[0]);
    }
    const invocation = {
      id: `pi-subagent:${event.toolCallId}`,
      toolCallId: event.toolCallId,
      mode: spec.mode,
      status: "running",
      tasks: spec.tasks.map((task, index) => ({
        id: `pi-subtask:${event.toolCallId}:${index}`,
        agent: shortText(task?.agent, 120) || "Agent",
        task: shortText(task?.task),
        index,
        status: "running",
        summary: "",
        position: {
          x: spec.mode === "chain" ? 180 + index * 260 : 180 + (index % 3) * 260,
          y: spec.mode === "chain" ? 230 : 150 + Math.floor(index / 3) * 150,
        },
      })),
    };
    this.#invocations.set(event.toolCallId, invocation);
    return true;
  }

  #applyResults(invocation, results, completed) {
    if (!Array.isArray(results)) return;
    for (let index = 0; index < Math.min(results.length, invocation.tasks.length); index += 1) {
      const result = results[index];
      const task = invocation.tasks[index];
      if (!result || !task) continue;
      if (invocation.mode === "parallel" && result.exitCode === -1) {
        task.status = "running";
        continue;
      }
      if (invocation.mode === "chain" && !completed) {
        const isCurrentStep = index === results.length - 1;
        task.status = isCurrentStep ? "running" : resultStatus(result, true);
      } else if (completed || invocation.mode === "parallel") {
        task.status = resultStatus(result, completed || result.exitCode !== -1);
      }
      task.summary = resultSummary(result);
    }
  }

  snapshot() {
    const nodes = [];
    const edges = [];
    for (const invocation of this.#invocations.values()) {
      nodes.push({
        id: invocation.id,
        kind: "invocation",
        label: `Pi subagent · ${invocation.mode}`,
        description: `${invocation.tasks.length} delegated task${invocation.tasks.length === 1 ? "" : "s"}`,
        status: invocation.status,
        position: { x: 20, y: invocation.tasks[0]?.position.y ?? 150 },
      });
      invocation.tasks.forEach((task, index) => {
        nodes.push({
          id: task.id,
          kind: "subtask",
          label: `${task.agent}: ${task.task.slice(0, 100) || "(empty task)"}`,
          description: task.task,
          status: task.status,
          summary: task.summary,
          position: task.position,
        });
        if (invocation.mode === "chain" && index > 0) {
          edges.push({
            id: `${invocation.id}:chain:${index}`,
            source: invocation.tasks[index - 1].id,
            target: task.id,
          });
        } else {
          edges.push({
            id: `${invocation.id}:spawn:${index}`,
            source: invocation.id,
            target: task.id,
          });
        }
      });
    }
    return { nodes, edges };
  }
}
