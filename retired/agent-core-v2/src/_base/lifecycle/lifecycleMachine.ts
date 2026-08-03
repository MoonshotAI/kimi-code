/**
 * `_base.lifecycle` — in-memory lifecycle transitions with guarded async transactions.
 *
 * Provides a domain-independent state holder that enters a transition state before
 * asynchronous work begins and coordinates explicit commit, rollback, cleanup, and
 * compensation actions. It has no persistence, event, DI, or scope dependencies.
 */

export type LifecycleTransitionErrorReason =
  | 'invalid_state'
  | 'transition_conflict'
  | 'missing_commit_state'
  | 'missing_rollback_state'
  | 'already_committed'
  | 'already_rolled_back';

export interface LifecycleTransitionErrorOptions<TState extends string> {
  readonly reason: LifecycleTransitionErrorReason;
  readonly operation: string;
  readonly state: TState;
  readonly expected?: TState | readonly TState[];
  readonly activeOperation?: string;
}

export class LifecycleTransitionError<TState extends string = string> extends Error {
  readonly reason: LifecycleTransitionErrorReason;
  readonly operation: string;
  readonly state: TState;
  readonly expected?: TState | readonly TState[];
  readonly activeOperation?: string;

  constructor(options: LifecycleTransitionErrorOptions<TState>) {
    super(formatTransitionError(options));
    this.name = 'LifecycleTransitionError';
    this.reason = options.reason;
    this.operation = options.operation;
    this.state = options.state;
    this.expected = options.expected;
    this.activeOperation = options.activeOperation;
  }
}

export interface LifecycleSnapshot<TState extends string> {
  readonly state: TState;
  readonly transitioning: boolean;
  readonly operation?: string;
}

export interface LifecycleSwitchOptions<TState extends string> {
  readonly operation: string;
  readonly from: TState | readonly TState[];
  readonly to: TState;
}

export interface LifecycleTransactionOptions<TState extends string> {
  readonly operation: string;
  readonly from: TState | readonly TState[];
  readonly enter: TState;
  readonly commit?: TState;
  readonly rollback?: TState;
}

export interface LifecycleTransaction<TState extends string> {
  defer(callback: LifecycleAction): void;
  rollback(callback: LifecycleAction): void;
  afterCommit(callback: LifecycleAction): void;
  commit(state: TState): void;
  rollbackTo(state: TState): void;
}

export type LifecycleAction = () => void | Promise<void>;

export class LifecycleMachine<TState extends string> {
  private _state: TState;
  private activeOperation: string | undefined;

  constructor(initial: TState) {
    this._state = initial;
  }

  get state(): TState {
    return this._state;
  }

  get snapshot(): LifecycleSnapshot<TState> {
    return this.activeOperation === undefined
      ? { state: this._state, transitioning: false }
      : {
          state: this._state,
          transitioning: true,
          operation: this.activeOperation,
        };
  }

  is(...states: readonly TState[]): boolean {
    return states.includes(this._state);
  }

  switch(options: LifecycleSwitchOptions<TState>): void {
    this.assertIdle(options.operation);
    this.assertState(options.operation, options.from);
    this._state = options.to;
  }

  async transaction<TResult>(
    options: LifecycleTransactionOptions<TState>,
    callback: (transaction: LifecycleTransaction<TState>) => TResult | Promise<TResult>,
  ): Promise<TResult> {
    this.assertIdle(options.operation);
    this.assertState(options.operation, options.from);

    this.activeOperation = options.operation;
    this._state = options.enter;

    const deferred: LifecycleAction[] = [];
    const rollbacks: LifecycleAction[] = [];
    const afterCommit: LifecycleAction[] = [];
    let commitState = options.commit;
    let rollbackState = options.rollback;
    let commitSelected = false;
    let rollbackSelected = false;

    const transaction: LifecycleTransaction<TState> = {
      defer: (action) => deferred.push(action),
      rollback: (action) => rollbacks.push(action),
      afterCommit: (action) => afterCommit.push(action),
      commit: (state) => {
        if (commitSelected) {
          throw this.createError(options.operation, 'already_committed');
        }
        commitSelected = true;
        commitState = state;
      },
      rollbackTo: (state) => {
        if (rollbackSelected) {
          throw this.createError(options.operation, 'already_rolled_back');
        }
        rollbackSelected = true;
        rollbackState = state;
      },
    };

    try {
      let result: TResult;
      try {
        result = await callback(transaction);
      } catch (error) {
        const errors: unknown[] = [
          error,
          ...(await runActions(rollbacks)),
          ...(await runActions(deferred)),
        ];

        if (rollbackState === undefined) {
          errors.push(this.createError(options.operation, 'missing_rollback_state'));
        } else {
          this._state = rollbackState;
        }
        throw aggregateErrors(errors, `Lifecycle transaction "${options.operation}" failed`);
      }

      if (commitState === undefined) {
        throw this.createError(options.operation, 'missing_commit_state');
      }

      const cleanupErrors = await runActions(deferred);
      this._state = commitState;
      const afterCommitErrors = await runActions(afterCommit);
      const errors = [...cleanupErrors, ...afterCommitErrors];
      if (errors.length > 0) {
        throw aggregateErrors(
          errors,
          `Lifecycle transaction "${options.operation}" committed with action failures`,
        );
      }
      return result;
    } finally {
      this.activeOperation = undefined;
    }
  }

  private assertIdle(operation: string): void {
    if (this.activeOperation === undefined) return;
    throw this.createError(operation, 'transition_conflict', undefined, this.activeOperation);
  }

  private assertState(operation: string, expected: TState | readonly TState[]): void {
    const states = Array.isArray(expected) ? expected : [expected];
    if (states.includes(this._state)) return;
    throw this.createError(operation, 'invalid_state', expected);
  }

  private createError(
    operation: string,
    reason: LifecycleTransitionErrorReason,
    expected?: TState | readonly TState[],
    activeOperation?: string,
  ): LifecycleTransitionError<TState> {
    return new LifecycleTransitionError({
      reason,
      operation,
      state: this._state,
      expected,
      activeOperation,
    });
  }
}

async function runActions(actions: readonly LifecycleAction[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    try {
      await actions[index]!();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function aggregateErrors(errors: readonly unknown[], message: string): unknown {
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, message, { cause: errors[0] });
}

function formatTransitionError<TState extends string>(
  options: LifecycleTransitionErrorOptions<TState>,
): string {
  switch (options.reason) {
    case 'invalid_state':
      return `Lifecycle operation "${options.operation}" is not allowed from state "${options.state}"`;
    case 'transition_conflict':
      return `Lifecycle operation "${options.operation}" conflicts with active operation "${options.activeOperation}"`;
    case 'missing_commit_state':
      return `Lifecycle operation "${options.operation}" did not select a commit state`;
    case 'missing_rollback_state':
      return `Lifecycle operation "${options.operation}" did not select a rollback state`;
    case 'already_committed':
      return `Lifecycle operation "${options.operation}" already selected a commit state`;
    case 'already_rolled_back':
      return `Lifecycle operation "${options.operation}" already selected a rollback state`;
  }
}
