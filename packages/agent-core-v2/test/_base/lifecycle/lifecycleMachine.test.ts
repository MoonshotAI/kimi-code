import { describe, expect, it } from 'vitest';

import {
  LifecycleMachine,
  LifecycleTransitionError,
} from '#/_base/lifecycle/lifecycleMachine';

type State = 'idle' | 'running' | 'completed' | 'failed';

describe('LifecycleMachine', () => {
  it('switches synchronously from an allowed state', () => {
    const machine = new LifecycleMachine<State>('idle');

    machine.switch({ operation: 'start', from: 'idle', to: 'running' });

    expect(machine.state).toBe('running');
    expect(machine.is('idle', 'running')).toBe(true);
    expect(machine.snapshot).toEqual({ state: 'running', transitioning: false });
  });

  it('rejects a synchronous switch from an invalid state', () => {
    const machine = new LifecycleMachine<State>('completed');

    expect(() =>
      machine.switch({ operation: 'start', from: 'idle', to: 'running' }),
    ).toThrowError(
      expect.objectContaining({
        reason: 'invalid_state',
        operation: 'start',
        state: 'completed',
      }),
    );
    expect(machine.state).toBe('completed');
  });

  it('enters the transition state before invoking async work', async () => {
    const machine = new LifecycleMachine<State>('idle');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed: State[] = [];

    const running = machine.transaction(
      {
        operation: 'run',
        from: 'idle',
        enter: 'running',
        commit: 'completed',
        rollback: 'failed',
      },
      async () => {
        observed.push(machine.state);
        await gate;
        observed.push(machine.state);
        return 42;
      },
    );

    expect(machine.snapshot).toEqual({
      state: 'running',
      transitioning: true,
      operation: 'run',
    });
    release();

    await expect(running).resolves.toBe(42);
    expect(observed).toEqual(['running', 'running']);
    expect(machine.state).toBe('completed');
  });

  it('supports dynamic commit and rollback targets', async () => {
    const completed = new LifecycleMachine<State>('idle');
    await completed.transaction(
      { operation: 'run', from: 'idle', enter: 'running', rollback: 'failed' },
      async (transaction) => {
        transaction.commit('completed');
      },
    );
    expect(completed.state).toBe('completed');

    const failed = new LifecycleMachine<State>('idle');
    await expect(
      failed.transaction(
        { operation: 'run', from: 'idle', enter: 'running', commit: 'completed' },
        async (transaction) => {
          transaction.rollbackTo('failed');
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');
    expect(failed.state).toBe('failed');
  });

  it('runs success actions in defer, commit, afterCommit order', async () => {
    const machine = new LifecycleMachine<State>('idle');
    const order: string[] = [];

    await machine.transaction(
      {
        operation: 'run',
        from: 'idle',
        enter: 'running',
        commit: 'completed',
        rollback: 'failed',
      },
      async (transaction) => {
        transaction.defer(() => {
          order.push(`defer-1:${machine.state}`);
        });
        transaction.defer(() => {
          order.push(`defer-2:${machine.state}`);
        });
        transaction.afterCommit(() => {
          order.push(`commit-1:${machine.state}`);
        });
        transaction.afterCommit(() => {
          order.push(`commit-2:${machine.state}`);
        });
      },
    );

    expect(order).toEqual([
      'defer-2:running',
      'defer-1:running',
      'commit-2:completed',
      'commit-1:completed',
    ]);
  });

  it('runs rollback and defer actions in LIFO order on failure', async () => {
    const machine = new LifecycleMachine<State>('idle');
    const order: string[] = [];
    const failure = new Error('boom');

    await expect(
      machine.transaction(
        {
          operation: 'run',
          from: 'idle',
          enter: 'running',
          commit: 'completed',
          rollback: 'failed',
        },
        async (transaction) => {
          transaction.rollback(() => {
            order.push('rollback-1');
          });
          transaction.rollback(() => {
            order.push('rollback-2');
          });
          transaction.defer(() => {
            order.push('defer-1');
          });
          transaction.defer(() => {
            order.push('defer-2');
          });
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    expect(order).toEqual(['rollback-2', 'rollback-1', 'defer-2', 'defer-1']);
    expect(machine.state).toBe('failed');
  });

  it('rejects concurrent and nested transitions', async () => {
    const machine = new LifecycleMachine<State>('idle');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = machine.transaction(
      {
        operation: 'first',
        from: 'idle',
        enter: 'running',
        commit: 'completed',
        rollback: 'failed',
      },
      async () => gate,
    );

    expect(() =>
      machine.switch({ operation: 'nested', from: 'running', to: 'failed' }),
    ).toThrowError(
      expect.objectContaining({
        reason: 'transition_conflict',
        operation: 'nested',
        activeOperation: 'first',
      }),
    );

    let called = false;
    await expect(
      machine.transaction(
        {
          operation: 'second',
          from: 'running',
          enter: 'running',
          commit: 'completed',
          rollback: 'failed',
        },
        async () => {
          called = true;
        },
      ),
    ).rejects.toMatchObject({ reason: 'transition_conflict' });
    expect(called).toBe(false);

    release();
    await running;
  });

  it('rejects repeated dynamic target selection', async () => {
    const commitMachine = new LifecycleMachine<State>('idle');
    await expect(
      commitMachine.transaction(
        { operation: 'run', from: 'idle', enter: 'running', rollback: 'failed' },
        async (transaction) => {
          transaction.commit('completed');
          transaction.commit('failed');
        },
      ),
    ).rejects.toMatchObject({ reason: 'already_committed' });
    expect(commitMachine.state).toBe('failed');

    const rollbackMachine = new LifecycleMachine<State>('idle');
    await expect(
      rollbackMachine.transaction(
        {
          operation: 'run',
          from: 'idle',
          enter: 'running',
          commit: 'completed',
          rollback: 'failed',
        },
        async (transaction) => {
          transaction.rollbackTo('idle');
          transaction.rollbackTo('failed');
        },
      ),
    ).rejects.toMatchObject({ reason: 'already_rolled_back' });
    expect(rollbackMachine.state).toBe('idle');
  });

  it('reports missing commit and rollback targets', async () => {
    const missingCommit = new LifecycleMachine<State>('idle');
    await expect(
      missingCommit.transaction(
        { operation: 'run', from: 'idle', enter: 'running', rollback: 'failed' },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ reason: 'missing_commit_state' });
    expect(missingCommit.state).toBe('running');

    const missingRollback = new LifecycleMachine<State>('idle');
    const failure = new Error('boom');
    let caught: unknown;
    try {
      await missingRollback.transaction(
        { operation: 'run', from: 'idle', enter: 'running', commit: 'completed' },
        async () => {
          throw failure;
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([
      failure,
      expect.objectContaining({ reason: 'missing_rollback_state' }),
    ]);
    expect(missingRollback.state).toBe('running');
  });

  it('aggregates action failures without losing the primary error', async () => {
    const machine = new LifecycleMachine<State>('idle');
    const failure = new Error('callback');
    const rollbackFailure = new Error('rollback');
    const deferFailure = new Error('defer');
    let caught: unknown;

    try {
      await machine.transaction(
        {
          operation: 'run',
          from: 'idle',
          enter: 'running',
          commit: 'completed',
          rollback: 'failed',
        },
        async (transaction) => {
          transaction.rollback(() => {
            throw rollbackFailure;
          });
          transaction.defer(() => {
            throw deferFailure;
          });
          throw failure;
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).cause).toBe(failure);
    expect((caught as AggregateError).errors).toEqual([
      failure,
      rollbackFailure,
      deferFailure,
    ]);
    expect(machine.state).toBe('failed');
  });

  it('commits before reporting cleanup and afterCommit failures', async () => {
    const machine = new LifecycleMachine<State>('idle');
    const deferFailure = new Error('defer');
    const afterCommitFailure = new Error('afterCommit');
    let caught: unknown;

    try {
      await machine.transaction(
        {
          operation: 'run',
          from: 'idle',
          enter: 'running',
          commit: 'completed',
          rollback: 'failed',
        },
        async (transaction) => {
          transaction.defer(() => {
            throw deferFailure;
          });
          transaction.afterCommit(() => {
            expect(machine.state).toBe('completed');
            throw afterCommitFailure;
          });
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([deferFailure, afterCommitFailure]);
    expect(machine.state).toBe('completed');
  });

  it('releases the transition lock after completion and failure', async () => {
    const completed = new LifecycleMachine<State>('idle');
    await completed.transaction(
      {
        operation: 'run',
        from: 'idle',
        enter: 'running',
        commit: 'completed',
        rollback: 'failed',
      },
      async () => undefined,
    );
    completed.switch({ operation: 'reset', from: 'completed', to: 'idle' });
    expect(completed.state).toBe('idle');

    const failed = new LifecycleMachine<State>('idle');
    await expect(
      failed.transaction(
        {
          operation: 'run',
          from: 'idle',
          enter: 'running',
          commit: 'completed',
          rollback: 'failed',
        },
        async () => {
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');
    failed.switch({ operation: 'reset', from: 'failed', to: 'idle' });
    expect(failed.state).toBe('idle');
  });

  it('exposes a dedicated transition error type', () => {
    const machine = new LifecycleMachine<State>('completed');

    expect(() =>
      machine.switch({ operation: 'start', from: 'idle', to: 'running' }),
    ).toThrow(LifecycleTransitionError);
  });
});
