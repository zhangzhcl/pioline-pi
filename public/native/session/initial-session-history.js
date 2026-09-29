export function shouldApplyInitialDiskHistory({
  diskMessages,
  expectedSessionId,
  currentSessionId,
  snapshot = null,
  snapshotStarted = false,
  currentSequence,
  currentLifecycle = "idle",
}) {
  if (
    expectedSessionId !== currentSessionId ||
    !Array.isArray(diskMessages) ||
    diskMessages.length === 0
  ) {
    return false;
  }
  if (snapshotStarted || currentLifecycle === "working") return false;
  if (!snapshot) return true;
  return diskMessages.length > snapshot.messageCount && currentSequence === snapshot.sequence;
}
