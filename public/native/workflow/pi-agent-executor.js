// ABOUTME: Runs workflow Pi Agent nodes through the active native Pi RPC session.

import { extractRuntimeEventError } from "../session/assistant-error.js";
import { randomId } from "../utils/random-id.js";
import { nodeMetaKey } from "./builtin-node-registry.js";

const SETTLE_TIMEOUT_MS = 10 * 60_000;

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new DOMException("Pi task cancelled", "AbortError");
}

function textFromContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("\n")
    .trim();
}

function waitForAgentSettled(runtime, target, signal) {
  if (typeof runtime.subscribe !== "function")
    throw new Error("Pi runtime events are unavailable for this workflow node");
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let agentStarted = false;
    let finalAgentError = null;
    const finish = (error) => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new DOMException("Pi task cancelled", "AbortError"));
    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for the Pi Agent node")),
      SETTLE_TIMEOUT_MS,
    );
    unsubscribe = runtime.subscribe((frame) => {
      if (frame?.type === "runtime_connection" && frame.connected === false) {
        finish(new Error("Pi runtime disconnected while waiting for the workflow node"));
        return;
      }
      if (frame?.type !== "runtime_event") return;
      if (frame.target?.instanceId !== target.instanceId) return;
      if (frame.event?.type === "agent_start") {
        agentStarted = true;
        finalAgentError = null;
      } else if (agentStarted && frame.event?.type === "agent_end") {
        finalAgentError = frame.event.willRetry ? null : extractRuntimeEventError(frame.event);
      } else if (agentStarted && frame.event?.type === "agent_settled") {
        finish(finalAgentError ? new Error(finalAgentError) : null);
      }
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createPiAgentExecutor({
  runtime,
  getTarget,
  getModel = () => null,
  onPiRunningChange = () => {},
}) {
  if (!runtime || typeof getTarget !== "function")
    throw new TypeError("Pi Agent executor requires the active native runtime target");

  return async ({ node, meta, inputs, params, workflow, nodeMetas, signal, log }) => {
    throwIfCancelled(signal);
    const target = getTarget();
    if (!target?.workspaceId || !target?.sessionId || !target?.instanceId)
      throw new Error("The active Pi session is unavailable");
    const topology = {
      name: workflow.name,
      revision: workflow.revision,
      nodes: workflow.nodes.map(({ instanceId, meta: reference }) => {
        const definition = nodeMetas?.get(nodeMetaKey(reference));
        return {
          id: instanceId,
          meta: {
            id: reference?.id,
            version: reference?.version,
            type: definition?.type,
            label: definition?.label,
          },
        };
      }),
      edges: workflow.edges.map(({ sourceNodeId, sourcePort, targetNodeId, targetPort }) => ({
        sourceNodeId,
        sourcePort,
        targetNodeId,
        targetPort,
      })),
    };
    const structuredOutputRequested =
      meta?.outputs?.some((port) => port.name === "json") &&
      workflow.edges.some(
        (edge) => edge.sourceNodeId === node.instanceId && edge.sourcePort === "json",
      );
    const prompt = [
      "This request is a Pi Agent node in a user-started Pipline workflow. Execute only this node's focused task using your normal Pi tools and workspace permissions.",
      `Workflow graph (JSON):\n${JSON.stringify(topology)}`,
      `Workflow node: ${node.instanceId}`,
      `Run: ${workflow.id} at revision ${workflow.revision}`,
      `Task:\n${params.prompt}`,
      `Input context (JSON):\n${JSON.stringify(inputs.context ?? {})}`,
      ...(structuredOutputRequested
        ? [
            "The downstream workflow consumes this node's JSON output. Return one valid JSON object only, without Markdown fences.",
          ]
        : []),
      "Return the node result clearly. Do not claim work that was not completed.",
    ].join("\n\n");
    const settleController = new AbortController();
    const cancelWait = () => settleController.abort();
    signal?.addEventListener("abort", cancelWait, { once: true });
    const settled = waitForAgentSettled(runtime, target, settleController.signal);
    settled.catch(() => {});
    const abortRuntime = () => {
      runtime.request({ type: "abort" }, target, { idempotencyKey: randomId() }).catch(() => {});
    };
    signal?.addEventListener("abort", abortRuntime, { once: true });
    try {
      onPiRunningChange(true);
      const model = getModel();
      if (model?.provider && model?.id) {
        await runtime.request(
          { type: "set_model", provider: model.provider, modelId: model.id },
          target,
          { idempotencyKey: randomId() },
        );
        throwIfCancelled(signal);
      }
      const beforeSnapshot = await runtime.snapshot(target.sessionId);
      throwIfCancelled(signal);
      const beforeMessages = Array.isArray(beforeSnapshot?.state?.messages)
        ? beforeSnapshot.state.messages
        : [];
      const beforeMessageIds = new Set(
        beforeMessages.map((message) => message?.id).filter((id) => typeof id === "string"),
      );
      log?.("Pi Agent node sent to the active Pi session.");
      throwIfCancelled(signal);
      await runtime.request({ type: "prompt", message: prompt }, target, {
        idempotencyKey: randomId(),
      });
      await settled;
      if (signal?.aborted) throw new DOMException("Pi task cancelled", "AbortError");
      const snapshot = await runtime.snapshot(target.sessionId);
      const messages = Array.isArray(snapshot?.state?.messages) ? snapshot.state.messages : [];
      const newMessages = messages.filter((message, index) =>
        typeof message?.id === "string"
          ? !beforeMessageIds.has(message.id)
          : index >= beforeMessages.length,
      );
      const lastAssistant = [...newMessages]
        .reverse()
        .find((message) => message.role === "assistant");
      const content = textFromContent(lastAssistant?.content);
      if (!content)
        throw new Error("Pi Agent node completed without a new assistant text response");
      log?.("Pi Agent node completed.");
      const output = { content };
      if (meta?.outputs?.some((port) => port.name === "json")) {
        try {
          const parsed = JSON.parse(content);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) output.json = parsed;
        } catch {
          // Plain text remains a successful Pi response; the optional JSON port stays empty.
        }
      }
      return output;
    } finally {
      onPiRunningChange(false);
      signal?.removeEventListener("abort", abortRuntime);
      signal?.removeEventListener("abort", cancelWait);
      settleController.abort();
    }
  };
}
