// src/budget.ts
//
// Parse budget: a hard cap on wall-clock time and on the number of syntax
// nodes a single parse may create. The parser calls `budget.tick()` every time
// it creates a node; when either limit is exceeded `tick` throws `Aborted`,
// which the `parse` entry point catches and reports as
// `{ ok: false, reason: 'aborted' }`.

export const DEFAULT_TIMEOUT_MS = 50;
export const DEFAULT_MAX_NODES = 50_000;

/** Internal control-flow error. Never escapes the `parse` entry point. */
export class Aborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Aborted';
  }
}

export interface BudgetOptions {
  /** Wall-clock limit in milliseconds. `Infinity` disables the time check. */
  timeoutMs?: number;
  /** Maximum number of nodes the parse may create. */
  maxNodes?: number;
}

export class ParseBudget {
  private readonly deadline: number;
  private readonly maxNodes: number;
  private nodeCount = 0;

  constructor(options: BudgetOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.deadline = Date.now() + timeoutMs;
    this.maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  }

  /** Number of nodes created so far. */
  get nodesUsed(): number {
    return this.nodeCount;
  }

  /**
   * Account for one created node and re-check the deadline. Throws `Aborted`
   * when the node cap is exceeded or the deadline has been reached.
   */
  tick(): void {
    this.nodeCount++;
    if (this.nodeCount > this.maxNodes) {
      throw new Aborted(`parse aborted: node budget exceeded (${this.nodeCount} > ${this.maxNodes})`);
    }
    if (Date.now() >= this.deadline) {
      throw new Aborted(`parse aborted: timeout`);
    }
  }
}
