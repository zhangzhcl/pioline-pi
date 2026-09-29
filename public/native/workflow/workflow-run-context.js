// ABOUTME: Creates bounded Run state for Pi workflow context reads.

export function boundedAgentValue(value, maxLength = 2_000) {
  if (value === undefined) return undefined;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { unavailable: true };
  }
  if (serialized.length > maxLength)
    return { truncated: true, preview: serialized.slice(0, maxLength) };
  return value;
}

export function workflowRunContextSummary({ run, activeNodeMetas, localizeNodeMeta, nodeMetaKey }) {
  if (!run) return null;
  const workflowNodes = run.snapshot?.nodes ?? [];
  const nodeStates = run.nodeStates ?? {};
  const nodes = workflowNodes.slice(0, 100).map((node) => {
    const meta = activeNodeMetas.get(nodeMetaKey(node.meta));
    const display = localizeNodeMeta(meta);
    const state = nodeStates[node.instanceId] ?? { status: "idle" };
    return {
      instanceId: node.instanceId,
      label: display?.label ?? node.meta?.id ?? node.instanceId,
      type: meta?.type ?? "unknown",
      status: state.status,
      ...(state.error ? { error: String(state.error).slice(0, 1_000) } : {}),
      ...(state.logs?.length
        ? { recentLogs: state.logs.slice(-3).map((line) => String(line).slice(0, 400)) }
        : {}),
      ...(state.output !== null && state.output !== undefined
        ? { output: boundedAgentValue(state.output) }
        : {}),
    };
  });
  const count = (status) =>
    Object.values(nodeStates).filter((state) => state.status === status).length;
  const nodeLabels = new Map(nodes.map((node) => [node.instanceId, node.label]));
  return {
    id: run.id,
    status: run.status,
    ...(run.retryOfRunId ? { retryOfRunId: run.retryOfRunId } : {}),
    ...(run.resumeFromNodeId ? { resumeFromNodeId: run.resumeFromNodeId } : {}),
    workflowRevision: run.workflowRevision,
    maxConcurrency: run.maxConcurrency ?? 1,
    progress: {
      total: workflowNodes.length,
      running: count("running"),
      waiting: count("idle"),
      succeeded: count("success"),
      failed: count("error"),
      skipped: count("skipped"),
      interrupted: count("interrupted"),
    },
    activeNodes: workflowNodes
      .filter((node) => nodeStates[node.instanceId]?.status === "running")
      .map((node) => {
        const meta = activeNodeMetas.get(nodeMetaKey(node.meta));
        return {
          instanceId: node.instanceId,
          label: localizeNodeMeta(meta)?.label ?? node.meta?.id ?? node.instanceId,
          type: meta?.type ?? "unknown",
        };
      }),
    nodes,
    omittedNodeCount: Math.max(0, workflowNodes.length - nodes.length),
    ...(run.error ? { error: String(run.error).slice(0, 2_000) } : {}),
    ...(run.result !== null && run.result !== undefined
      ? { result: boundedAgentValue(run.result, 8_000) }
      : {}),
    recentEvents: (Array.isArray(run.events) ? run.events : []).slice(-16).map((event) => ({
      type: event.type,
      ...(event.nodeId
        ? {
            nodeId: event.nodeId,
            nodeLabel: nodeLabels.get(event.nodeId) ?? event.nodeId,
          }
        : {}),
      ...(event.error ? { error: String(event.error).slice(0, 800) } : {}),
      ...(event.message ? { message: String(event.message).slice(0, 400) } : {}),
      ...(event.reason ? { reason: String(event.reason).slice(0, 300) } : {}),
    })),
  };
}
