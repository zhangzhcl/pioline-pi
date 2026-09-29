// ABOUTME: Bounded snapshot history for workflow undo and redo operations.

const DEFAULT_LIMIT = 100;

export class WorkflowHistory {
  #limit;
  #undo = [];
  #redo = [];

  constructor(limit = DEFAULT_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new TypeError("limit must be a positive integer");
    this.#limit = limit;
  }

  record(before, after) {
    if (!before || !after || before.id !== after.id || before.workspaceId !== after.workspaceId)
      throw new TypeError("Workflow history snapshots must share an identity");
    this.#undo.push({ before: structuredClone(before), after: structuredClone(after) });
    if (this.#undo.length > this.#limit) this.#undo.shift();
    this.#redo = [];
  }

  canUndo() {
    return this.#undo.length > 0;
  }

  canRedo() {
    return this.#redo.length > 0;
  }

  prepareUndo(current) {
    const entry = this.#undo.at(-1);
    if (!entry) return null;
    if (!sameGraph(entry.after, current)) {
      this.clear();
      return null;
    }
    return { target: structuredClone(entry.before), entry };
  }

  matchesUndo(current, entry) {
    return this.#undo.at(-1) === entry && sameGraph(entry.after, current);
  }

  commitUndo(entry) {
    if (this.#undo.at(-1) !== entry) throw new Error("Workflow undo history changed");
    this.#undo.pop();
    this.#redo.push(entry);
  }

  prepareRedo(current) {
    const entry = this.#redo.at(-1);
    if (!entry) return null;
    if (!sameGraph(entry.before, current)) {
      this.clear();
      return null;
    }
    return { target: structuredClone(entry.after), entry };
  }

  matchesRedo(current, entry) {
    return this.#redo.at(-1) === entry && sameGraph(entry.before, current);
  }

  commitRedo(entry) {
    if (this.#redo.at(-1) !== entry) throw new Error("Workflow redo history changed");
    this.#redo.pop();
    this.#undo.push(entry);
  }

  clear() {
    this.#undo = [];
    this.#redo = [];
  }
}

function sameGraph(left, right) {
  return (
    JSON.stringify({ nodes: left.nodes, edges: left.edges }) ===
    JSON.stringify({ nodes: right.nodes, edges: right.edges })
  );
}
