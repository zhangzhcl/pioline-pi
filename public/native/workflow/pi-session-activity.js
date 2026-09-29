// ABOUTME: Tracks whether a Pi session is processing work from another window.

function sameTarget(left, right) {
  return (
    left?.workspaceId === right?.workspaceId &&
    left?.sessionId === right?.sessionId &&
    left?.instanceId === right?.instanceId
  );
}

function isPiBusy(state) {
  return state?.isStreaming === true || state?.isCompacting === true;
}

export function createPiSessionActivity(runtime) {
  if (!runtime || typeof runtime.request !== "function" || typeof runtime.subscribe !== "function")
    throw new TypeError("Pi session activity requires a subscribed runtime gateway");

  let target = null;
  let busy = false;
  let generation = 0;
  let eventRevision = 0;

  const syncTarget = async (nextTarget = target) => {
    target = nextTarget;
    const currentGeneration = ++generation;
    eventRevision += 1;
    const requestRevision = eventRevision;
    if (!target) {
      busy = false;
      return;
    }
    // Fail closed until get_state confirms the session is idle.
    busy = true;
    try {
      const response = await runtime.request({ type: "get_state" }, target);
      if (currentGeneration !== generation || requestRevision !== eventRevision) return;
      if (response?.response?.success !== true) return;
      busy = isPiBusy(response.response.data);
    } catch {
      // Keep the session locked until a later connection or target sync succeeds.
    }
  };

  const unsubscribe = runtime.subscribe((frame) => {
    if (frame?.type === "runtime_connection") {
      if (frame.connected === false) {
        generation += 1;
        eventRevision += 1;
        busy = Boolean(target);
      } else if (frame.connected === true && target) {
        void syncTarget(target);
      }
      return;
    }
    if (frame?.type !== "runtime_event" || !sameTarget(frame.target, target)) return;
    if (frame.event?.type === "agent_start") {
      eventRevision += 1;
      busy = true;
    } else if (frame.event?.type === "agent_settled") {
      eventRevision += 1;
      busy = false;
    }
  });

  return {
    getBusy: () => Boolean(target && busy),
    setTarget: syncTarget,
    dispose() {
      generation += 1;
      target = null;
      busy = false;
      unsubscribe();
    },
  };
}
