// ABOUTME: Turns recorded turn traces into a timing/failure/redundancy report.
// ABOUTME: Pure functions, no DOM and no i18n -- findings carry keys + params.

/**
 * Turn analysis.
 *
 * Answers the four questions a "why was this slow / why did it fail" debugger
 * has to answer, entirely from the spans `turn-trace.js` recorded:
 *
 * 1. Where did the time go?   -> phase split (model / tool / compaction / idle)
 * 2. What got stuck?          -> longest span, plus spans that never ended
 * 3. Where did it fail?       -> first failing span and every later one
 * 4. What was wasted?         -> identical tool calls, retry loops, re-reads
 *
 * Every verdict is a `finding`: `{ severity, code, params }`. The code is an
 * i18n key suffix and the params are already formatted numbers/labels, so the
 * panel renders findings without re-deriving anything. Nothing here guesses at
 * intent: a duplicate call is reported as a duplicate call, not as "the agent
 * was confused".
 */

const DEFAULT_THRESHOLDS = {
  slowStepMs: 30_000,
  slowStepShare: 0.3,
  // Below this a turn is fast enough that no share-based verdict is useful:
  // "the model took 90% of 800ms" is noise, not a bottleneck.
  minInterestingMs: 3_000,
  idleMs: 5_000,
  idleShare: 0.2,
  duplicateMin: 2,
  repeatedFileMin: 3,
  retryMin: 2,
  wastedShare: 0.15,
  dominantShare: 0.6,
};

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

const READ_LIKE_TOOLS = new Set([
  "read",
  "Read",
  "read_file",
  "readFile",
  "view",
  "cat",
  "grep",
  "Grep",
  "search",
]);

/** Merge spans so overlapping tool calls are not counted twice. */
export function mergedDuration(spans) {
  const ranges = spans
    .filter((span) => Number.isFinite(span.startedAt) && Number.isFinite(span.endedAt))
    .map((span) => [span.startedAt, Math.max(span.startedAt, span.endedAt)])
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = null;
  for (const [start, end] of ranges) {
    if (!cursor) {
      cursor = [start, end];
      continue;
    }
    if (start <= cursor[1]) {
      cursor[1] = Math.max(cursor[1], end);
      continue;
    }
    total += cursor[1] - cursor[0];
    cursor = [start, end];
  }
  if (cursor) total += cursor[1] - cursor[0];
  return total;
}

function stepShare(ms, totalMs) {
  return totalMs > 0 ? ms / totalMs : 0;
}

function finishedSteps(turns) {
  const steps = [];
  for (const turn of turns) {
    for (const step of turn.steps) steps.push({ ...step, turnIndex: turn.index, turnId: turn.id });
  }
  return steps;
}

function summarizeStep(step) {
  return {
    turnIndex: step.turnIndex ?? null,
    kind: step.kind,
    label: step.label,
    detail: step.detail || "",
    toolNames: Array.isArray(step.toolNames) ? step.toolNames : [],
    status: step.status,
    error: step.error || null,
    durationMs: Number(step.durationMs) || 0,
    startedAt: step.startedAt ?? null,
  };
}

function groupToolStepsBy(steps, getKey) {
  const groups = new Map();
  for (const step of steps) {
    if (step.kind !== "tool") continue;
    const key = getKey(step);
    if (!key) continue;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(step);
  }
  return groups;
}

function sumDurationMs(steps) {
  let sum = 0;
  for (const step of steps) sum += Number(step.durationMs) || 0;
  return sum;
}

/** Identical tool calls (same tool, same arguments) executed more than once. */
function findDuplicateCalls(steps, thresholds) {
  const groups = groupToolStepsBy(steps, (step) => step.signature);
  const duplicates = [];
  const signatures = new Set();
  for (const [signature, bucket] of groups) {
    if (bucket.length < thresholds.duplicateMin) continue;
    signatures.add(signature);
    duplicates.push({
      code: "duplicateCalls",
      label: bucket[0].label,
      detail: bucket[0].detail || "",
      count: bucket.length,
      wastedMs: sumDurationMs(bucket.slice(1)),
      turnIndex: bucket[0].turnIndex ?? null,
    });
  }
  duplicates.sort((a, b) => b.wastedMs - a.wastedMs || b.count - a.count);
  return { entries: duplicates, signatures };
}

/** The same call failing again and again -- a retry loop, not progress. */
function findRetryLoops(steps, thresholds) {
  const groups = groupToolStepsBy(steps, (step) => (step.status === "error" ? step.signature : ""));
  const loops = [];
  for (const bucket of groups.values()) {
    if (bucket.length < thresholds.retryMin) continue;
    loops.push({
      code: "retryLoop",
      label: bucket[0].label,
      detail: bucket[0].detail || "",
      count: bucket.length,
      wastedMs: sumDurationMs(bucket),
      error: bucket[bucket.length - 1].error || null,
      turnIndex: bucket[0].turnIndex ?? null,
    });
  }
  return loops.sort((a, b) => b.count - a.count);
}

/** The same file/pattern read over and over with slightly different args. */
function findRepeatedTargets(steps, thresholds, duplicateSignatures) {
  const groups = groupToolStepsBy(steps, (step) =>
    READ_LIKE_TOOLS.has(step.label) ? step.detail : "",
  );
  const repeats = [];
  for (const [detail, bucket] of groups) {
    if (bucket.length < thresholds.repeatedFileMin) continue;
    // An exact duplicate is already reported as one; only flag the softer
    // "same target, different arguments" pattern here.
    if (bucket.every((step) => duplicateSignatures.has(step.signature))) continue;
    repeats.push({
      code: "repeatedTarget",
      label: bucket[0].label,
      detail,
      count: bucket.length,
      wastedMs: sumDurationMs(bucket.slice(1)),
      turnIndex: bucket[0].turnIndex ?? null,
    });
  }
  return repeats.sort((a, b) => b.count - a.count);
}

function formatMs(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatShare(share) {
  return `${Math.round((Number(share) || 0) * 100)}%`;
}

export { formatMs, formatShare };

/**
 * Analyze one or more recorded turns.
 *
 * @param {Array<object>} turns - turns from `turn-trace.js` (chronological).
 * @param {{ thresholds?: object, now?: () => number, topSteps?: number }} [options]
 * @returns {object} report
 */
export function analyzeTurns(
  turns,
  { thresholds: overrides, now = () => Date.now(), topSteps = 5 } = {},
) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(overrides || {}) };
  const list = Array.isArray(turns) ? turns.filter(Boolean) : [];
  const steps = finishedSteps(list);

  const wallMs = list.reduce((sum, turn) => {
    const end = Number.isFinite(turn.endedAt) ? turn.endedAt : now();
    return sum + Math.max(0, end - turn.startedAt);
  }, 0);

  const byKind = (kind) => steps.filter((step) => step.kind === kind);
  const toolSteps = byKind("tool");
  const modelSteps = byKind("model");
  const toolMs = mergedDuration(toolSteps);
  const compactionMs = mergedDuration(byKind("compaction"));
  // Model spans enclose the tool calls they trigger in some runtimes, so model
  // time is reported as "model span minus the tool time inside it" and the
  // remainder becomes idle rather than being double counted.
  const modelSpanMs = mergedDuration(modelSteps);
  const busyMs = mergedDuration(steps);
  const modelMs = Math.max(0, busyMs - toolMs - compactionMs);
  const idleMs = Math.max(0, wallMs - busyMs);

  const phases = [
    { kind: "model", ms: modelMs },
    { kind: "tool", ms: toolMs },
    { kind: "compaction", ms: compactionMs },
    { kind: "idle", ms: idleMs },
  ].map((phase) => ({ ...phase, share: stepShare(phase.ms, wallMs) }));

  const ranked = [...steps]
    .sort((a, b) => (Number(b.durationMs) || 0) - (Number(a.durationMs) || 0))
    .map((step) => ({ ...summarizeStep(step), share: stepShare(step.durationMs, wallMs) }));
  const slowest = ranked.slice(0, topSteps);
  const bottleneck = ranked[0] ?? null;

  const unfinished = steps.filter((step) => step.status === "unfinished").map(summarizeStep);
  const failures = steps
    .filter((step) => step.status === "error")
    .map(summarizeStep)
    .concat(
      list
        .filter((turn) => turn.status === "failed" && turn.error)
        .map((turn) => ({
          turnIndex: turn.index,
          kind: "turn",
          label: "turn",
          detail: "",
          status: "error",
          error: turn.error,
          durationMs: Number(turn.durationMs) || 0,
          startedAt: turn.startedAt ?? null,
        })),
    )
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

  const duplicates = findDuplicateCalls(steps, thresholds);
  const retryLoops = findRetryLoops(steps, thresholds);
  const repeatedTargets = findRepeatedTargets(steps, thresholds, duplicates.signatures);
  const redundancies = [...duplicates.entries, ...retryLoops, ...repeatedTargets];
  const wastedMs = redundancies.reduce((sum, entry) => sum + (Number(entry.wastedMs) || 0), 0);

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const turn of list) {
    usage.input += Number(turn.usage?.input) || 0;
    usage.output += Number(turn.usage?.output) || 0;
    usage.cacheRead += Number(turn.usage?.cacheRead) || 0;
    usage.cacheWrite += Number(turn.usage?.cacheWrite) || 0;
    usage.cost += Number(turn.usage?.cost) || 0;
  }

  const status =
    ["failed", "running", "aborted", "unknown"].find((candidate) =>
      list.some((turn) => turn.status === candidate),
    ) ?? "completed";

  const totals = {
    turns: list.length,
    wallMs,
    modelMs,
    modelSpanMs,
    toolMs,
    compactionMs,
    idleMs,
    busyMs,
    wastedMs,
    wastedShare: stepShare(wastedMs, wallMs),
    toolCalls: toolSteps.length,
    modelCalls: modelSteps.length,
    failureCount: failures.length,
    usage,
  };

  return {
    status,
    totals,
    phases,
    slowest,
    // Lets the panel skip the "slowest steps" section when it would be a
    // verbatim re-render of every row already in the step timeline (ranking
    // only earns its own section once it actually filters something out).
    totalSteps: steps.length,
    bottleneck,
    unfinished,
    failures,
    firstFailure: failures[0] ?? null,
    redundancies,
    findings: buildFindings({
      status,
      totals,
      phases,
      bottleneck,
      unfinished,
      failures,
      redundancies,
      thresholds,
    }),
    turns: list.map((turn) => ({
      id: turn.id,
      index: turn.index,
      prompt: turn.prompt || "",
      status: turn.status,
      error: turn.error || null,
      durationMs: Number(turn.durationMs) || 0,
      stepCount: turn.steps.length,
    })),
  };
}

function buildFindings({
  status,
  totals,
  phases,
  bottleneck,
  unfinished,
  failures,
  redundancies,
  thresholds,
}) {
  const findings = [];
  const phaseShare = (kind) => phases.find((phase) => phase.kind === kind)?.share ?? 0;

  if (status === "failed" && failures.length) {
    const first = failures[0];
    findings.push({
      severity: "critical",
      code: "failedAt",
      params: {
        label: first.label,
        detail: first.detail,
        error: first.error || "",
        duration: formatMs(first.durationMs),
      },
    });
  } else if (status === "aborted") {
    findings.push({ severity: "warning", code: "aborted", params: {} });
  } else if (status === "unknown") {
    findings.push({ severity: "warning", code: "unknownEnd", params: {} });
  }

  if (unfinished.length) {
    const worst = [...unfinished].sort((a, b) => b.durationMs - a.durationMs)[0];
    findings.push({
      severity: "critical",
      code: "stuckStep",
      params: {
        label: worst.label,
        detail: worst.detail,
        duration: formatMs(worst.durationMs),
        count: unfinished.length,
      },
    });
  }

  const toolFailures = failures.filter((failure) => failure.kind === "tool");
  if (toolFailures.length) {
    findings.push({
      severity: "warning",
      code: "toolFailures",
      params: {
        count: toolFailures.length,
        label: toolFailures[0].label,
        error: toolFailures[0].error || "",
      },
    });
  }

  const bottleneckIsSlow =
    bottleneck &&
    (bottleneck.durationMs >= thresholds.slowStepMs ||
      (bottleneck.share >= thresholds.slowStepShare &&
        bottleneck.durationMs >= thresholds.minInterestingMs));
  if (bottleneckIsSlow) {
    findings.push({
      severity: "warning",
      code: "slowStep",
      params: {
        label: bottleneck.label,
        detail: bottleneck.detail,
        duration: formatMs(bottleneck.durationMs),
        share: formatShare(bottleneck.share),
      },
    });
  }

  if (totals.idleMs >= thresholds.idleMs && phaseShare("idle") >= thresholds.idleShare) {
    findings.push({
      severity: "warning",
      code: "idleTime",
      params: { duration: formatMs(totals.idleMs), share: formatShare(phaseShare("idle")) },
    });
  }

  for (const entry of redundancies.slice(0, 5)) {
    findings.push({
      severity: entry.code === "retryLoop" ? "critical" : "warning",
      code: entry.code,
      params: {
        label: entry.label,
        detail: entry.detail,
        count: entry.count,
        wasted: formatMs(entry.wastedMs),
        error: entry.error || "",
      },
    });
  }

  if (totals.wastedMs > 0 && totals.wastedShare >= thresholds.wastedShare) {
    findings.push({
      severity: "warning",
      code: "wastedTime",
      params: { duration: formatMs(totals.wastedMs), share: formatShare(totals.wastedShare) },
    });
  }

  // "The model took 90% of 800ms" is noise, so share verdicts need a floor.
  const longEnough = totals.wallMs >= thresholds.minInterestingMs;
  if (longEnough && phaseShare("tool") >= thresholds.dominantShare) {
    findings.push({
      severity: "info",
      code: "toolBound",
      params: { share: formatShare(phaseShare("tool")), count: totals.toolCalls },
    });
  } else if (longEnough && phaseShare("model") >= thresholds.dominantShare) {
    findings.push({
      severity: "info",
      code: "modelBound",
      params: { share: formatShare(phaseShare("model")), count: totals.modelCalls },
    });
  }

  if (totals.compactionMs > 0) {
    findings.push({
      severity: "info",
      code: "compaction",
      params: {
        duration: formatMs(totals.compactionMs),
        share: formatShare(phaseShare("compaction")),
      },
    });
  }

  if (!findings.length) {
    findings.push({
      severity: "info",
      code: "healthy",
      params: { duration: formatMs(totals.wallMs), count: totals.toolCalls },
    });
  }

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
