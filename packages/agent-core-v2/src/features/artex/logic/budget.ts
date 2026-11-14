export const ARTEX_BUDGET_UNLIMITED = Number.MAX_SAFE_INTEGER;

export const ARTEX_BUDGET_MARGIN_PERCENT = 5;
export const ARTEX_BUDGET_MARGIN_MIN_TOKENS = 20_000;
export const ARTEX_BUDGET_MARGIN_MIN_TURNS = 2;
export const ARTEX_DEFAULT_WORKER_ESTIMATE_TOKENS = 50_000;
export const ARTEX_DEFAULT_WORKER_ESTIMATE_TURNS = 10;

export interface ArtexBudget {
  readonly tokens: number;
  readonly turns: number;
}

export interface ArtexSpend {
  readonly tokens: number;
  readonly turns: number;
}

export interface ArtexBudgetUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function budgetCap(n: number): number {
  return n <= 0 ? ARTEX_BUDGET_UNLIMITED : n;
}

export function newArtexBudget(tokens: number, turns: number): ArtexBudget {
  return { tokens: budgetCap(tokens), turns: budgetCap(turns) };
}

export function effectiveBudget(own: ArtexBudget, parentRemaining: ArtexBudget): ArtexBudget {
  return {
    tokens: Math.min(own.tokens, parentRemaining.tokens),
    turns: Math.min(own.turns, parentRemaining.turns),
  };
}

function left(capacity: number, spent: number): number {
  if (capacity === ARTEX_BUDGET_UNLIMITED) return ARTEX_BUDGET_UNLIMITED;
  return Math.max(capacity - spent, 0);
}

export function remainingBudget(budget: ArtexBudget, spend: ArtexSpend): ArtexBudget {
  return { tokens: left(budget.tokens, spend.tokens), turns: left(budget.turns, spend.turns) };
}

export function wrapupMargin(task: ArtexBudget): ArtexBudget {
  const m = (capacity: number, floor: number): number => {
    if (capacity === ARTEX_BUDGET_UNLIMITED) return 0;
    return Math.max(Math.floor((capacity * ARTEX_BUDGET_MARGIN_PERCENT) / 100), floor);
  };
  return {
    tokens: m(task.tokens, ARTEX_BUDGET_MARGIN_MIN_TOKENS),
    turns: m(task.turns, ARTEX_BUDGET_MARGIN_MIN_TURNS),
  };
}

function addUsage(spend: ArtexSpend, usage: ArtexBudgetUsage): ArtexSpend {
  return {
    tokens: spend.tokens + usage.inputTokens + usage.outputTokens,
    turns: spend.turns + 1,
  };
}

export interface ArtexBudgetState {
  readonly task: ArtexBudget;
  readonly remaining: ArtexBudget;
  readonly margin: ArtexBudget;
  readonly spent: ArtexSpend;
  readonly estimate: ArtexSpend;
  readonly atMargin: boolean;
  readonly dispatch: boolean;
}

export function artexBudgetStateLine(state: ArtexBudgetState): string {
  const of = (rem: number, capacity: number): string => {
    if (capacity === ARTEX_BUDGET_UNLIMITED) return 'unlimited';
    return `${String(rem)} of ${String(capacity)}`;
  };
  return (
    `[Task budget] remaining: tokens ${of(state.remaining.tokens, state.task.tokens)}, ` +
    `turns ${of(state.remaining.turns, state.task.turns)} ` +
    `(wrap-up reserve: ${String(state.margin.tokens)} tokens, ${String(state.margin.turns)} turns)`
  );
}

const ZERO_SPEND: ArtexSpend = { tokens: 0, turns: 0 };

export class ArtexBudgetLedger {
  private spent: ArtexSpend = ZERO_SPEND;
  private workerRuns = 0;
  private workerSpent: ArtexSpend = ZERO_SPEND;
  private wrapup = false;

  private constructor(
    private readonly task: ArtexBudget,
    private readonly intent: ArtexBudget,
  ) {}

  static create(task: ArtexBudget, intent: ArtexBudget): ArtexBudgetLedger | undefined {
    const unlimited = newArtexBudget(0, 0);
    if (
      task.tokens === unlimited.tokens &&
      task.turns === unlimited.turns &&
      intent.tokens === unlimited.tokens &&
      intent.turns === unlimited.turns
    ) {
      return undefined;
    }
    return new ArtexBudgetLedger(task, intent);
  }

  record(usage: ArtexBudgetUsage): void {
    this.spent = addUsage(this.spent, usage);
  }

  state(): ArtexBudgetState {
    const remaining = remainingBudget(this.task, this.spent);
    const margin = wrapupMargin(this.task);
    let estimate: ArtexSpend = {
      tokens: ARTEX_DEFAULT_WORKER_ESTIMATE_TOKENS,
      turns: ARTEX_DEFAULT_WORKER_ESTIMATE_TURNS,
    };
    if (this.workerRuns > 0) {
      estimate = {
        tokens: Math.floor(this.workerSpent.tokens / this.workerRuns),
        turns: Math.floor(this.workerSpent.turns / this.workerRuns),
      };
    }
    estimate = {
      tokens: Math.min(estimate.tokens, this.intent.tokens),
      turns: Math.min(estimate.turns, this.intent.turns),
    };
    const atMargin =
      (remaining.tokens !== ARTEX_BUDGET_UNLIMITED && remaining.tokens <= margin.tokens) ||
      (remaining.turns !== ARTEX_BUDGET_UNLIMITED && remaining.turns <= margin.turns);
    return {
      task: this.task,
      remaining,
      margin,
      spent: this.spent,
      estimate,
      atMargin,
      dispatch:
        !this.wrapup &&
        !atMargin &&
        remaining.tokens >= estimate.tokens &&
        remaining.turns >= estimate.turns,
    };
  }

  beginWrapup(): boolean {
    const first = !this.wrapup;
    this.wrapup = true;
    return first;
  }

  startIntent(): ArtexIntentMeter {
    return new ArtexIntentMeter(this);
  }

  /** @internal */
  recordIntentUsage(meter: ArtexIntentMeter, usage: ArtexBudgetUsage): void {
    meter.applySpend(addUsage(meter.spend, usage));
    this.spent = addUsage(this.spent, usage);
  }

  /** @internal */
  intentRemaining(meter: ArtexIntentMeter): ArtexBudget {
    let parent: ArtexBudget = { tokens: 0, turns: 0 };
    if (!this.wrapup) {
      const remaining = remainingBudget(this.task, this.spent);
      const reserve = wrapupMargin(this.task);
      parent = {
        tokens: left(remaining.tokens, reserve.tokens),
        turns: left(remaining.turns, reserve.turns),
      };
    }
    return effectiveBudget(remainingBudget(this.intent, meter.spend), parent);
  }

  /** @internal */
  finishIntent(meter: ArtexIntentMeter): void {
    this.workerRuns += 1;
    this.workerSpent = {
      tokens: this.workerSpent.tokens + meter.spend.tokens,
      turns: this.workerSpent.turns + meter.spend.turns,
    };
  }
}

export class ArtexIntentMeter {
  private spentInternal: ArtexSpend = ZERO_SPEND;

  constructor(private readonly ledger: ArtexBudgetLedger) {}

  get spend(): ArtexSpend {
    return this.spentInternal;
  }

  /** @internal */
  applySpend(spend: ArtexSpend): void {
    this.spentInternal = spend;
  }

  record(usage: ArtexBudgetUsage): void {
    this.ledger.recordIntentUsage(this, usage);
  }

  remaining(): ArtexBudget {
    return this.ledger.intentRemaining(this);
  }

  exhausted(): boolean {
    const r = this.remaining();
    return r.tokens === 0 || r.turns === 0;
  }

  finish(): void {
    this.ledger.finishIntent(this);
  }
}

export function artexBudgetWrapupBlocks(tool: string): boolean {
  return (
    tool !== 'record_fact' &&
    tool !== 'insert_assets' &&
    tool !== 'report_finding' &&
    tool !== 'update_finding_report' &&
    tool !== 'record_coverage'
  );
}
