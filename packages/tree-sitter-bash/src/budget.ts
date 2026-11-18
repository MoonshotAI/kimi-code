export const DEFAULT_TIMEOUT_MS = 50;
export const DEFAULT_MAX_NODES = 50_000;

export class Aborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Aborted';
  }
}

export interface BudgetOptions {
  timeoutMs?: number;
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

  get nodesUsed(): number {
    return this.nodeCount;
  }

  tick(): void {
    this.nodeCount++;
    if (this.nodeCount > this.maxNodes) {
      throw new Aborted(`parse aborted: node budget exceeded (${this.nodeCount} > ${this.maxNodes})`);
    }
    if (Date.now() >= this.deadline) {
      throw new Aborted(`parse aborted: timeout`);
    }
  }

  progress(): void {
    if (Date.now() >= this.deadline) {
      throw new Aborted(`parse aborted: timeout`);
    }
  }
}
