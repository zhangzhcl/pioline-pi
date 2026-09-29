// ABOUTME: Serialize Pi workflow-tool ownership as the foreground chat session changes.

export function getWorkflowModeTargetTransition(currentTarget, nextTarget, workspaceId) {
  const isValidTarget =
    typeof workspaceId === "string" &&
    workspaceId.length > 0 &&
    typeof nextTarget?.workspaceId === "string" &&
    nextTarget.workspaceId === workspaceId &&
    typeof nextTarget.sessionId === "string" &&
    nextTarget.sessionId.length > 0 &&
    typeof nextTarget.instanceId === "string" &&
    nextTarget.instanceId.length > 0;
  const acceptedTarget = isValidTarget ? nextTarget : null;
  if (!acceptedTarget) {
    return {
      disableTarget: currentTarget ?? null,
      enableTarget: null,
      nextTarget: null,
    };
  }

  if (
    currentTarget?.sessionId === acceptedTarget.sessionId &&
    currentTarget?.workspaceId === acceptedTarget.workspaceId &&
    currentTarget?.instanceId === acceptedTarget.instanceId
  ) {
    return { disableTarget: null, enableTarget: null, nextTarget: currentTarget };
  }

  return {
    disableTarget: currentTarget ?? null,
    enableTarget: acceptedTarget,
    nextTarget: acceptedTarget,
  };
}

export function createWorkflowModeTargetSynchronizer({
  getTarget,
  getWorkspaceId,
  isOpen,
  setToolsEnabled,
}) {
  let activeTarget = null;
  let generation = 0;
  let queue = Promise.resolve();
  const pendingDisableTargets = new Map();

  function targetKey(target) {
    return `${target.workspaceId}\u0000${target.sessionId}\u0000${target.instanceId}`;
  }

  function enqueue(operation) {
    queue = queue.catch(() => {}).then(operation);
    return queue;
  }

  async function disableTarget(target) {
    await setToolsEnabled(false, target);
    pendingDisableTargets.delete(targetKey(target));
    if (activeTarget === target) activeTarget = null;
  }

  return {
    sync() {
      const requestGeneration = ++generation;
      return enqueue(async () => {
        if (requestGeneration !== generation || !isOpen()) return;
        for (const pendingTarget of pendingDisableTargets.values()) {
          try {
            await disableTarget(pendingTarget);
          } catch {
            // Retry stale sessions on later syncs without blocking the foreground session.
          }
        }
        const transition = getWorkflowModeTargetTransition(
          activeTarget,
          getTarget(),
          getWorkspaceId(),
        );
        if (transition.disableTarget) {
          try {
            await disableTarget(transition.disableTarget);
          } catch (error) {
            // A stale target must not block activation of the current session.
            pendingDisableTargets.set(
              targetKey(transition.disableTarget),
              transition.disableTarget,
            );
            if (!transition.enableTarget) throw error;
          }
        }
        if (requestGeneration !== generation) return;
        if (!transition.enableTarget) return;

        const nextTarget = transition.enableTarget;
        try {
          await setToolsEnabled(true, nextTarget);
        } catch (error) {
          // Treat a failed enable as potentially applied; a later sync/close
          // must disable this target before trying another one.
          activeTarget = nextTarget;
          throw error;
        }
        activeTarget = nextTarget;
        if (requestGeneration !== generation || !isOpen()) await disableTarget(nextTarget);
      });
    },

    close() {
      generation += 1;
      return enqueue(async () => {
        const targets = new Map(pendingDisableTargets);
        if (activeTarget) targets.set(targetKey(activeTarget), activeTarget);
        let firstError = null;
        for (const target of targets.values()) {
          try {
            await disableTarget(target);
          } catch (error) {
            pendingDisableTargets.set(targetKey(target), target);
            firstError ??= error;
          }
        }
        if (firstError) throw firstError;
      });
    },
  };
}
