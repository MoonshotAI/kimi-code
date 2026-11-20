import { describe, expect, it, vi } from 'vitest';

import {
  createActor,
  isProcessCancelled,
  type ActorControl,
  type ProcessControl,
} from '#/actor/index';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('createActor', () => {
  it('runs synchronous act with ack, settles onSchedule before event delivery, and fires afterDeliver after subscribers', async () => {
    type State =
      | { readonly status: 'idle' }
      | { readonly status: 'running'; readonly job: string };
    type Ev =
      | { readonly type: 'submitted'; readonly job: string }
      | { readonly type: 'started'; readonly job: string }
      | { readonly type: 'finished'; readonly job: string };

    const queue: string[] = [];
    const history: string[] = [];
    const timeline: string[] = [];
    const work = deferred<void>();

    const actor = createActor<State, Ev>({
      initial: { status: 'idle' },
      onEmit: (event) => {
        history.push(`${event.type}:${event.job}`);
      },
      onSchedule: (ctrl) => {
        if (ctrl.state.status !== 'idle' || queue.length === 0) return;
        const job = queue.shift()!;
        ctrl.setState({ status: 'running', job });
        ctrl.spawn(async (proc) => {
          proc.emit({ type: 'started', job });
          await proc.step(() => work.promise);
          proc.emit({ type: 'finished', job });
          proc.afterDeliver(() => {
            timeline.push(`afterDeliver:${job}`);
          });
          proc.setState({ status: 'idle' });
        });
      },
      isIdle: (state) => state.status === 'idle' && queue.length === 0,
    });

    actor.subscribe((event) => {
      timeline.push(`event:${event.type}:${actor.state.status}:queued=${queue.length}`);
    });

    const ack = actor.act((ctrl) => {
      queue.push('alpha');
      return ctrl.emit({ type: 'submitted', job: 'alpha' });
    });

    expect(ack).toEqual({ type: 'submitted', job: 'alpha' });
    expect(actor.state).toEqual({ status: 'running', job: 'alpha' });
    expect(history).toEqual(['submitted:alpha', 'started:alpha']);
    expect(timeline).toEqual([
      'event:submitted:running:queued=0',
      'event:started:running:queued=0',
    ]);

    work.resolve();
    await actor.waitForIdle();
    expect(actor.state).toEqual({ status: 'idle' });
    expect(timeline).toEqual([
      'event:submitted:running:queued=0',
      'event:started:running:queued=0',
      'event:finished:idle:queued=0',
      'afterDeliver:alpha',
    ]);
    await actor.close();
  });

  it('supports linear async/await loops with step, checkpoint, and waitUntil', async () => {
    type Phase = 'idle' | 'fetching' | 'waiting_gate';
    type Ev = { readonly type: 'round'; readonly index: number; readonly value: string };

    let gateOpen = false;
    const isGateOpen = () => gateOpen;
    const waiting = deferred<void>();
    const rounds: Ev[] = [];

    const actor = createActor<Phase, Ev>({ initial: 'idle' });
    actor.subscribe((event) => rounds.push(event));

    const openGate = actor.bind(() => {
      gateOpen = true;
    });

    actor.act((ctrl) => {
      ctrl.spawn(async (proc) => {
        try {
          for (let index = 1; index <= 2; index += 1) {
            const fetched = await proc.step('fetching', async () => `item-${index}`);
            proc.setState('waiting_gate');
            waiting.resolve();
            await proc.waitUntil(isGateOpen);
            proc.emit({ type: 'round', index, value: fetched });
            proc.checkpoint();
          }
        } finally {
          proc.setState('idle');
        }
      });
    });

    await waiting.promise;
    expect(actor.state).toBe('waiting_gate');
    expect(rounds).toEqual([]);

    openGate();
    await actor.waitForIdle();
    expect(actor.state).toBe('idle');
    expect(rounds).toEqual([
      { type: 'round', index: 1, value: 'item-1' },
      { type: 'round', index: 2, value: 'item-2' },
    ]);
    await actor.close();
  });

  it('cleans up step-scoped resources on cancel and supports graceful onCancel settlement', async () => {
    vi.useFakeTimers();
    try {
      type Ev =
        | { readonly type: 'progress'; readonly text: string }
        | { readonly type: 'timer_fired' }
        | { readonly type: 'grace_result'; readonly value: string };

      const events: Ev[] = [];
      const exits: string[] = [];
      let capturedStepSignal: AbortSignal | undefined;
      let pushProgress: ((text: string) => void) | undefined;
      const neverEnding = deferred<string>();
      const firstStepStarted = deferred<void>();

      const actor = createActor<'idle' | 'working', Ev>({ initial: 'idle' });
      actor.subscribe((event) => events.push(event));

      const firstRun = actor.act((ctrl) =>
        ctrl.spawn(async (proc) => {
          try {
            await proc.step('working', (signal, step) => {
              capturedStepSignal = signal;
              step.onExit(() => exits.push('exit-1'));
              step.onExit(() => exits.push('exit-2'));
              pushProgress = step.bind((stepCtrl, text: string) => {
                stepCtrl.emit({ type: 'progress', text });
              });
              step.after(15, (stepCtrl) => {
                stepCtrl.emit({ type: 'timer_fired' });
              });
              firstStepStarted.resolve();
              return neverEnding.promise;
            });
          } finally {
            proc.setState('idle');
          }
        }),
      );

      await firstStepStarted.promise;
      pushProgress?.('live');
      expect(events).toEqual([{ type: 'progress', text: 'live' }]);
      expect(capturedStepSignal?.aborted).toBe(false);

      firstRun.cancel('abort-now');
      await firstRun.done;

      expect(capturedStepSignal?.aborted).toBe(true);
      expect(exits).toEqual(['exit-2', 'exit-1']);

      pushProgress?.('stale');
      neverEnding.resolve('late');
      await vi.advanceTimersByTimeAsync(30);
      expect(events).toEqual([{ type: 'progress', text: 'live' }]);

      const slowStream = deferred<string>();
      const gracefulStepStarted = deferred<void>();
      let stepDone: Promise<string> | undefined;
      const gracefulRun = actor.act((ctrl) =>
        ctrl.spawn(async (proc) => {
          const value = await proc.step<string>('working', (_signal, step) => {
            stepDone = step.done;
            step.onCancel((_cancelCtrl, _reason, count) => {
              if (count > 1) {
                step.resolve('forced-abort');
                return;
              }
              step.after(50, () => step.resolve('grace-expired'));
            });
            gracefulStepStarted.resolve();
            return slowStream.promise;
          });
          proc.emit({ type: 'grace_result', value });
          proc.setState('idle');
        }),
      );

      await gracefulStepStarted.promise;
      gracefulRun.cancel('first');
      expect(gracefulRun.cancelCount).toBe(1);
      gracefulRun.cancel('second');
      expect(gracefulRun.cancelCount).toBe(2);
      await gracefulRun.done;

      await expect(stepDone!).resolves.toBe('forced-abort');
      expect(events.at(-1)).toEqual({ type: 'grace_result', value: 'forced-abort' });
      await actor.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes non-cancellation process errors to onError and isolates listener errors', async () => {
    type Ev = { readonly type: 'ping'; readonly id: number };
    const capturedErrors: string[] = [];

    const actor = createActor<'idle', Ev>({
      initial: 'idle',
      onError: (_ctrl, error) => {
        capturedErrors.push(error instanceof Error ? error.message : String(error));
      },
    });

    const failing = actor.act((ctrl) =>
      ctrl.spawn(async () => {
        throw new Error('unexpected-boom');
      }),
    );
    await failing.done;
    expect(capturedErrors).toEqual(['unexpected-boom']);
    await actor.close();

    const seen: number[] = [];
    const unhandled = createActor<'idle', Ev>({ initial: 'idle' });
    unhandled.subscribe(() => {
      throw new Error('subscriber-failed');
    });
    unhandled.subscribe((event) => {
      seen.push(event.id);
    });
    expect(() => unhandled.act((ctrl) => ctrl.emit({ type: 'ping', id: 1 }))).toThrow('subscriber-failed');
    expect(seen).toEqual([1]);
    await unhandled.close();

    const reported: string[] = [];
    const isolated = createActor<'idle', Ev>({
      initial: 'idle',
      onListenerError: (error, event) => {
        reported.push(`${event.id}:${(error as Error).message}`);
      },
    });
    isolated.subscribe(() => {
      throw new Error('handled-error');
    });
    isolated.act((ctrl) => ctrl.emit({ type: 'ping', id: 2 }));
    expect(reported).toEqual(['2:handled-error']);
    await isolated.close();
  });

  it('rejects escaped control handles used outside their active synchronous turn or while suspended', async () => {
    type Ev = { readonly type: 'leaked' };
    const events: Ev[] = [];
    const actor = createActor<'idle' | 'hacked' | 'suspended', Ev>({ initial: 'idle' });
    actor.subscribe((event) => events.push(event));

    let escapedActCtrl: ActorControl<'idle' | 'hacked' | 'suspended', Ev> | undefined;
    let escapedLaunchCtrl: ActorControl<'idle' | 'hacked' | 'suspended', Ev> | undefined;
    let escapedProc: ProcessControl<'idle' | 'hacked' | 'suspended', Ev> | undefined;
    const stepGate = deferred<void>();
    const stepStarted = deferred<void>();

    actor.act((ctrl) => {
      escapedActCtrl = ctrl;
    });

    expect(() => escapedActCtrl!.setState('hacked')).toThrow(
      'ActorControl cannot be used outside its active synchronous turn',
    );
    expect(() => escapedActCtrl!.emit({ type: 'leaked' })).toThrow(
      'ActorControl cannot be used outside its active synchronous turn',
    );
    expect(actor.state).toBe('idle');
    expect(events).toEqual([]);

    const handle = actor.act((ctrl) =>
      ctrl.spawn(async (proc) => {
        escapedProc = proc;
        await proc.step('suspended', (_signal, _step, launchCtrl) => {
          escapedLaunchCtrl = launchCtrl;
          stepStarted.resolve();
          return stepGate.promise;
        });
        proc.setState('idle');
      }),
    );

    await stepStarted.promise;
    expect(actor.state).toBe('suspended');

    expect(() => escapedLaunchCtrl!.setState('hacked')).toThrow(
      'ActorControl cannot be used outside its active synchronous turn',
    );
    expect(() => escapedProc!.setState('hacked')).toThrow(
      'ActorControl cannot be used outside its active synchronous turn',
    );
    expect(() => escapedProc!.emit({ type: 'leaked' })).toThrow(
      'ActorControl cannot be used outside its active synchronous turn',
    );
    expect(() => escapedProc!.checkpoint()).toThrow(
      'ProcessControl cannot be used while suspended or after completion',
    );

    stepGate.resolve();
    await handle.done;

    expect(() => escapedProc!.setState('hacked')).toThrow(
      'ActorControl cannot be used outside its active synchronous turn',
    );
    expect(actor.state).toBe('idle');
    expect(events).toEqual([]);
    await actor.close();
  });

  it('refuses subsequent steps, waitUntil, and checkpoint even if a caller catch block swallows cancellation', async () => {
    const gate = deferred<void>();
    const stepStarted = deferred<void>();
    let secondStepRan = false;
    const caughtFlags: boolean[] = [];

    const actor = createActor<'idle' | 'step1' | 'step2'>({ initial: 'idle' });

    const handle = actor.act((ctrl) =>
      ctrl.spawn(async (proc) => {
        try {
          await proc.step('step1', () => {
            stepStarted.resolve();
            return gate.promise;
          });
        } catch (error) {
          caughtFlags.push(isProcessCancelled(error));
        }

        try {
          await proc.step('step2', () => {
            secondStepRan = true;
          });
        } catch (error) {
          caughtFlags.push(isProcessCancelled(error));
        }

        try {
          await proc.waitUntil(() => true);
        } catch (error) {
          caughtFlags.push(isProcessCancelled(error));
        }

        expect(() => proc.checkpoint()).toThrow('Actor process cancelled');
        proc.setState('idle');
      }),
    );

    await stepStarted.promise;
    expect(actor.state).toBe('step1');
    handle.cancel('stop');
    await handle.done;

    expect(secondStepRan).toBe(false);
    expect(caughtFlags).toEqual([true, true, true]);
    expect(actor.state).toBe('idle');
    await actor.close();
  });

  it('flushes final process events before async microtasks scheduled by earlier subscribers', async () => {
    type Ev = { readonly type: 'step.ended' } | { readonly type: 'turn.ended' };
    const order: string[] = [];
    const stepWork = deferred<void>();
    const subscriberMicrotask = deferred<void>();

    const actor = createActor<'idle' | 'running', Ev>({ initial: 'idle' });
    actor.subscribe((event) => {
      order.push(`emit:${event.type}`);
      if (event.type === 'step.ended') {
        void Promise.resolve().then(() => {
          order.push('async:wire.step.end');
          subscriberMicrotask.resolve();
        });
      }
    });

    actor.act((ctrl) => {
      ctrl.setState('running');
      ctrl.spawn(async (proc) => {
        try {
          await proc.step(() => stepWork.promise);
          proc.emit({ type: 'step.ended' });
          proc.checkpoint();
        } finally {
          proc.emit({ type: 'turn.ended' });
          proc.setState('idle');
        }
      });
    });

    stepWork.resolve();
    await actor.waitForIdle();
    await subscriberMicrotask.promise;

    expect(order).toEqual([
      'emit:step.ended',
      'emit:turn.ended',
      'async:wire.step.end',
    ]);
    await actor.close();
  });

  it('defers event delivery for re-entrant act, defer, and cancel inside subscribers', async () => {
    type Ev =
      | { readonly type: 'step.started'; readonly step: number }
      | { readonly type: 'step.ended'; readonly step: number }
      | { readonly type: 'reentrant.act' }
      | { readonly type: 'reentrant.defer' }
      | { readonly type: 'turn.ended'; readonly aborted: boolean };

    const firstSubscriber: string[] = [];
    const secondSubscriber: string[] = [];
    const startedSteps: number[] = [];
    const actor = createActor<'idle' | 'running', Ev>({ initial: 'idle' });

    actor.subscribe((event) => {
      firstSubscriber.push(event.type);
      if (event.type === 'step.ended') {
        actor.act((ctrl) => {
          ctrl.emit({ type: 'reentrant.act' });
          ctrl.defer((nextCtrl) => {
            nextCtrl.emit({ type: 'reentrant.defer' });
          });
        });
        handle?.cancel('listener-abort');
      }
    });
    actor.subscribe((event) => {
      secondSubscriber.push(event.type);
    });

    const handle = actor.act((ctrl) =>
      ctrl.spawn(async (proc) => {
        proc.setState('running');
        try {
          for (let step = 1; step <= 3; step += 1) {
            startedSteps.push(step);
            proc.emit({ type: 'step.started', step });
            proc.checkpoint();
            await proc.step(() => Promise.resolve());
            proc.emit({ type: 'step.ended', step });
            proc.checkpoint();
          }
        } finally {
          proc.emit({ type: 'turn.ended', aborted: proc.cancelled });
          proc.setState('idle');
        }
      }),
    );

    await handle.done;
    await actor.waitForIdle();

    expect(startedSteps).toEqual([1]);
    const expected = ['step.started', 'step.ended', 'reentrant.act', 'reentrant.defer', 'turn.ended'];
    expect(firstSubscriber).toEqual(expected);
    expect(secondSubscriber).toEqual(expected);
    await actor.close();
  });

  it('enforces terminal close finality across async onClose, active processes, rootSignal, and post-close calls', async () => {
    type Ev =
      | { readonly type: 'bg.done'; readonly tag: string }
      | { readonly type: 'proc.cleanup' }
      | { readonly type: 'close.done' };

    let bgPending = false;
    let capturedRootSignal: AbortSignal | undefined;
    const closeGate = deferred<void>();
    const processStarted = deferred<void>();
    const events: Ev[] = [];

    const actor = createActor<'idle', Ev>({
      initial: 'idle',
      isIdle: () => !bgPending,
      onClose: async (ctrl) => {
        capturedRootSignal = ctrl.rootSignal;
        await closeGate.promise;
      },
    });
    actor.subscribe((event) => events.push(event));

    const completeBg = actor.bind((ctrl, tag: string) => {
      bgPending = false;
      ctrl.emit({ type: 'bg.done', tag });
    });

    const runningProc = actor.act((ctrl) => {
      bgPending = true;
      return ctrl.spawn(async (proc) => {
        try {
          await proc.step(() => {
            processStarted.resolve();
            return new Promise<void>(() => undefined);
          });
        } finally {
          proc.emit({ type: 'proc.cleanup' });
        }
      });
    });

    await processStarted.promise;
    expect(actor.closing).toBe(false);
    expect(actor.closed).toBe(false);

    const firstClose = actor.close();
    const secondClose = actor.close();
    expect(secondClose).toBe(firstClose);
    expect(actor.closing).toBe(true);
    expect(actor.closed).toBe(false);
    expect(capturedRootSignal?.aborted).toBe(true);

    actor.act((ctrl) => {
      ctrl.defer((nextCtrl) => {
        nextCtrl.emit({ type: 'close.done' });
      });
    });
    closeGate.resolve();
    completeBg('during-closing');
    expect(actor.closed).toBe(false);

    runningProc.cancel('finish-proc');
    await firstClose;
    expect(actor.closed).toBe(true);
    expect(events).toEqual([
      { type: 'close.done' },
      { type: 'bg.done', tag: 'during-closing' },
      { type: 'proc.cleanup' },
    ]);

    completeBg('after-closed');
    expect(events).toHaveLength(3);
    expect(() => actor.act(() => undefined)).toThrow('Actor is closed');

    const defaultCloseActor = createActor<'idle', Ev>({ initial: 'idle' });
    const defaultEvents: Ev[] = [];
    const defaultProcessStarted = deferred<void>();
    defaultCloseActor.subscribe((ev) => defaultEvents.push(ev));
    const activeInDefault = defaultCloseActor.act((ctrl) =>
      ctrl.spawn(async (proc) => {
        try {
          await proc.step(() => {
            defaultProcessStarted.resolve();
            return new Promise<void>(() => undefined);
          });
        } finally {
          proc.emit({ type: 'proc.cleanup' });
        }
      }),
    );
    await defaultProcessStarted.promise;
    await defaultCloseActor.close();
    await activeInDefault.done;
    expect(defaultCloseActor.closed).toBe(true);
    expect(defaultEvents).toEqual([{ type: 'proc.cleanup' }]);

    const failingCloseEvents: Ev[] = [];
    const failingCloseActor = createActor<'idle', Ev>({
      initial: 'idle',
      onClose: async (ctrl) => {
        ctrl.emit({ type: 'close.done' });
        await Promise.resolve();
        throw new Error('close-rejected');
      },
    });
    failingCloseActor.subscribe((ev) => failingCloseEvents.push(ev));
    await expect(failingCloseActor.close()).rejects.toThrow('close-rejected');
    expect(failingCloseActor.closed).toBe(true);
    expect(failingCloseEvents).toEqual([{ type: 'close.done' }]);
    expect(() => failingCloseActor.act(() => undefined)).toThrow('Actor is closed');
  });

  it('waits for matching events and settles timeout and abort through the public wait API', async () => {
    vi.useFakeTimers();
    try {
      type Ev =
        | { readonly type: 'ping'; readonly id: number }
        | { readonly type: 'pong' };
      const actor = createActor<'idle', Ev>({ initial: 'idle' });
      const matching = actor.wait('ping', { match: (event) => event.id === 2 });
      const matched: number[] = [];
      void matching.then((event) => {
        matched.push(event.id);
      });

      actor.act((ctrl) => ctrl.emit({ type: 'pong' }));
      actor.act((ctrl) => ctrl.emit({ type: 'ping', id: 1 }));
      await Promise.resolve();
      expect(matched).toEqual([]);
      actor.act((ctrl) => ctrl.emit({ type: 'ping', id: 2 }));
      await expect(matching).resolves.toEqual({ type: 'ping', id: 2 });
      expect(matched).toEqual([2]);

      const timedOut = actor.wait('ping', { timeoutMs: 20 });
      const timeoutAssertion = expect(timedOut).rejects.toThrow('wait timed out after 20ms');
      await vi.advanceTimersByTimeAsync(20);
      await timeoutAssertion;

      const controller = new AbortController();
      const aborted = actor.wait('ping', { signal: controller.signal });
      const reason = new Error('stop-waiting');
      controller.abort(reason);
      await expect(aborted).rejects.toBe(reason);
      await actor.close();
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('createActor boundary coverage', () => {
  it('exposes process state, scopes, cancellation metadata, and scoped callback binding', async () => {
    type Ev =
      | { readonly type: 'bound'; readonly value: string }
      | { readonly type: 'deferred' }
      | { readonly type: 'child.done' };

    const events: Ev[] = [];
    const actor = createActor<'idle' | 'running', Ev>({ initial: 'idle' });
    actor.subscribe((event) => events.push(event));
    const rootSignal = actor.act((ctrl) => ctrl.rootSignal);
    let process: ProcessControl<'idle' | 'running', Ev> | undefined;

    const handle = actor.act((ctrl) => {
      const bound = ctrl.bind((boundCtrl, value: string) => {
        boundCtrl.emit({ type: 'bound', value });
      });
      bound('outer');
      return ctrl.spawn(async (proc) => {
        process = proc;
        expect(proc.state).toBe('idle');
        expect(proc.rootSignal).toBe(rootSignal);
        expect(proc.signal.aborted).toBe(false);
        expect(proc.cancelled).toBe(false);
        expect(proc.cancelReason).toBeUndefined();
        expect(proc.cancelCount).toBe(0);
        proc.setState('running');
        proc.defer((deferredCtrl) => {
          deferredCtrl.emit({ type: 'deferred' });
        });
        const innerBound = proc.bind((boundCtrl, value: string) => {
          boundCtrl.emit({ type: 'bound', value });
        });
        innerBound('inner');
        proc.spawn(async (child) => {
          child.emit({ type: 'child.done' });
        });
        await proc.step(() => Promise.resolve());
        proc.setState('idle');
      });
    });

    await handle.done;
    await actor.waitForIdle();
    expect(events).toHaveLength(4);
    expect(events).toContainEqual({ type: 'bound', value: 'outer' });
    expect(events).toContainEqual({ type: 'bound', value: 'inner' });
    expect(events).toContainEqual({ type: 'deferred' });
    expect(events).toContainEqual({ type: 'child.done' });
    expect(process?.state).toBe('idle');
    expect(handle.active).toBe(false);
    expect(handle.cancelled).toBe(false);
    expect(handle.cancelReason).toBeUndefined();
    expect(handle.cancelCount).toBe(0);
    expect(handle.signal.aborted).toBe(false);

    handle.cancel('after-done');
    expect(handle.cancelCount).toBe(0);
    await actor.close();
    expect(handle.signal.aborted).toBe(true);
    handle.cancel('after-close');
    expect(handle.cancelCount).toBe(0);
  });

  it('rethrows process and listener error-handler failures while preserving the first captured error', async () => {
    type Ev = { readonly type: 'ping' };
    const processError = new Error('process-error');
    const handlerError = new Error('handler-error');

    const withErrorHandler = createActor<'idle', Ev>({
      initial: 'idle',
      onError: () => {
        throw handlerError;
      },
    });
    expect(() => withErrorHandler.act((ctrl) => {
      ctrl.spawn(() => {
        throw processError;
      });
    })).toThrow(handlerError);
    await withErrorHandler.close();

    const withoutErrorHandler = createActor<'idle', Ev>({ initial: 'idle' });
    expect(() => withoutErrorHandler.act((ctrl) => {
      ctrl.spawn(() => {
        throw processError;
      });
    })).toThrow(processError);
    await withoutErrorHandler.close();

    const firstListenerError = new Error('first-listener-error');
    const secondListenerError = new Error('second-listener-error');
    const listeners = createActor<'idle', Ev>({ initial: 'idle' });
    listeners.subscribe(() => {
      throw firstListenerError;
    });
    listeners.subscribe(() => {
      throw secondListenerError;
    });
    expect(() => listeners.act((ctrl) => ctrl.emit({ type: 'ping' }))).toThrow(firstListenerError);
    await listeners.close();

    const listenerHandler = createActor<'idle', Ev>({
      initial: 'idle',
      onListenerError: () => {
        throw handlerError;
      },
    });
    listenerHandler.subscribe(() => {
      throw processError;
    });
    expect(() => listenerHandler.act((ctrl) => ctrl.emit({ type: 'ping' }))).toThrow(handlerError);
    await listenerHandler.close();
  });

  it('handles waitUntil cancellation, cross-process wake races, and re-entrant self-cancellation', async () => {
    type Ev = { readonly type: 'ready' };
    const actor = createActor<'idle', Ev>({ initial: 'idle' });
    const cancellations: unknown[] = [];
    let open = false;
    const waitingA = deferred<void>();
    const waitingB = deferred<void>();

    const handleA = actor.act((ctrl) =>
      ctrl.spawn(async (proc) => {
        proc.emit({ type: 'ready' });
        try {
          waitingA.resolve();
          await proc.waitUntil(() => open);
        } catch (error) {
          cancellations.push(isProcessCancelled(error));
        }
      }),
    );

    const handleB = actor.act((ctrl) =>
      ctrl.spawn(async (proc) => {
        try {
          waitingB.resolve();
          await proc.waitUntil(() => {
            if (open) handleA.cancel('cross-process');
            return false;
          });
        } catch (error) {
          cancellations.push(isProcessCancelled(error));
        }
      }),
    );

    await waitingA.promise;
    await waitingB.promise;
    const openGate = actor.bind(() => {
      open = true;
    });
    openGate();
    await handleA.done;
    handleB.cancel('finish-b');
    await handleB.done;

    let selfOpen = false;
    const selfWaiting = deferred<void>();
    const handleC = actor.act((ctrl) =>
      ctrl.spawn(async (proc) => {
        try {
          selfWaiting.resolve();
          await proc.waitUntil(() => {
            if (!selfOpen) return false;
            handleC.cancel('self-cancel');
            return true;
          });
        } catch (error) {
          cancellations.push(isProcessCancelled(error));
        }
      }),
    );
    await selfWaiting.promise;
    const openSelf = actor.bind(() => {
      selfOpen = true;
    });
    openSelf();
    await handleC.done;

    expect(cancellations).toEqual([true, true, true]);
    await actor.close();
  });

  it('covers early step cancellation, explicit rejection, timers, and late step controls', async () => {
    vi.useFakeTimers();
    try {
      type Ev = { readonly type: 'timer' };
      const actor = createActor<'idle', Ev>({ initial: 'idle' });
      let started = false;
      let earlyCancellation: unknown;

      const early = actor.act((ctrl) => {
        const handle = ctrl.spawn(async (proc) => {
          try {
            await proc.step(() => {
              started = true;
            });
          } catch (error) {
            earlyCancellation = error;
          }
        });
        handle.cancel('before-start');
        return handle;
      });
      await early.done;
      expect(started).toBe(false);
      expect(isProcessCancelled(earlyCancellation)).toBe(true);

      const stepError = new Error('step-rejected');
      let rejection: unknown;
      let lateExit = false;
      const rejecting = actor.act((ctrl) =>
        ctrl.spawn(async (proc) => {
          try {
            await proc.step<string>((signal, step, launchCtrl) => {
              expect(step.signal).toBe(signal);
              step.reject(stepError);
              expect(() => launchCtrl.setState('idle')).toThrow(
                'ActorControl cannot be used outside its active synchronous turn',
              );
              step.onExit(() => {
                lateExit = true;
              });
              const cancelLateTimer = step.after(0, () => undefined);
              cancelLateTimer();
              return 'late-result';
            });
          } catch (error) {
            rejection = error;
          }
        }),
      );
      await rejecting.done;
      expect(rejection).toBe(stepError);
      expect(lateExit).toBe(false);

      rejection = undefined;
      const asyncRejecting = actor.act((ctrl) =>
        ctrl.spawn(async (proc) => {
          try {
            await proc.step(() => Promise.reject(stepError));
          } catch (error) {
            rejection = error;
          }
        }),
      );
      await asyncRejecting.done;
      expect(rejection).toBe(stepError);

      const timerEvents: Ev[] = [];
      actor.subscribe((event) => timerEvents.push(event));
      const timerFired = deferred<void>();
      let cancelledTimerFired = false;
      let lateBoundCalls = 0;
      let lateTimerCalls = 0;
      let bindLate!: () => void;
      let settleTimerStep!: () => void;
      const timerRun = actor.act((ctrl) =>
        ctrl.spawn(async (proc) => {
          await proc.step<string>((_signal, step) => {
            const cancelTimer = step.after(5, () => {
              cancelledTimerFired = true;
            });
            cancelTimer();
            cancelTimer();
            step.after(10, (timerCtrl) => {
              timerCtrl.emit({ type: 'timer' });
              timerFired.resolve();
            });
            step.after(20, () => {
              lateTimerCalls += 1;
            });
            bindLate = step.bind(() => {
              lateBoundCalls += 1;
            });
            settleTimerStep = () => step.resolve('timer-done');
            return new Promise<string>(() => undefined);
          });
        }),
      );

      await vi.advanceTimersByTimeAsync(10);
      await timerFired.promise;
      expect(timerEvents).toEqual([{ type: 'timer' }]);
      actor.act(() => {
        bindLate();
        vi.advanceTimersByTime(20);
        settleTimerStep();
      });
      await timerRun.done;
      expect(cancelledTimerFired).toBe(false);
      expect(lateBoundCalls).toBe(0);
      expect(lateTimerCalls).toBe(0);

      let closeBoundCalls = 0;
      let closeTimerCalls = 0;
      let bindAfterClose!: () => void;
      let resolveOrphan!: () => void;
      const orphan = actor.act((ctrl) =>
        ctrl.spawn(async (proc) => {
          void proc.step<string>((_signal, step) => {
            resolveOrphan = () => step.resolve('late-orphan');
            bindAfterClose = step.bind(() => {
              closeBoundCalls += 1;
            });
            step.after(20, () => {
              closeTimerCalls += 1;
            });
            step.after(40, () => {
              closeTimerCalls += 1;
            });
            return new Promise<string>(() => undefined);
          });
        }),
      );
      await orphan.done;

      let closing: Promise<void> | undefined;
      actor.act(() => {
        closing = actor.close();
        bindAfterClose();
        vi.advanceTimersByTime(20);
      });
      await closing;
      bindAfterClose();
      await vi.advanceTimersByTimeAsync(40);
      resolveOrphan();
      await Promise.resolve();
      expect(closeBoundCalls).toBe(1);
      expect(closeTimerCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('covers scheduler re-entry, checkpoint wakeups, and afterDeliver continuations', async () => {
    type Ev =
      | { readonly type: 'scheduled' }
      | { readonly type: 'command' }
      | { readonly type: 'before.wait' }
      | { readonly type: 'injected' }
      | { readonly type: 'after.deliver' };

    const order: string[] = [];
    let scheduleProcess = true;
    const scheduled = createActor<'idle', Ev>({
      initial: 'idle',
      onSchedule: (ctrl) => {
        if (!scheduleProcess) return;
        scheduleProcess = false;
        ctrl.spawn(async () => {
          order.push('scheduled');
        });
      },
    });
    scheduled.act(() => undefined);
    await scheduled.waitForIdle();
    const spawnFromCommand = scheduled.bind(() => {
      scheduled.act((ctrl) => {
        ctrl.spawn(async () => {
          order.push('command');
        });
      });
    });
    spawnFromCommand();
    await scheduled.waitForIdle();
    expect(order).toEqual(['scheduled', 'command']);
    await scheduled.close();

    let injected = false;
    let waitingHandle: ReturnType<ActorControl<'idle', Ev>['spawn']> | undefined;
    const waiting = deferred<void>();
    const checkpointActor = createActor<'idle', Ev>({
      initial: 'idle',
      onSchedule: (ctrl) => {
        if (waitingHandle !== undefined) return;
        waitingHandle = ctrl.spawn(async (proc) => {
          proc.emit({ type: 'before.wait' });
          waiting.resolve();
          await proc.waitUntil(() => {
            if (!injected) {
              injected = true;
              inject();
            }
            return false;
          });
        });
      },
    });
    const inject = checkpointActor.bind((ctrl) => {
      ctrl.emit({ type: 'injected' });
    });
    checkpointActor.act(() => undefined);
    await waiting.promise;
    waitingHandle?.cancel('finish-checkpoint');
    await waitingHandle?.done;
    await checkpointActor.close();

    const work = deferred<void>();
    const afterDeliverEvents: Ev[] = [];
    const afterDeliverActor = createActor<'idle', Ev>({ initial: 'idle' });
    afterDeliverActor.subscribe((event) => afterDeliverEvents.push(event));
    const afterDelivered = afterDeliverActor.wait('after.deliver');
    const afterDeliverRun = afterDeliverActor.act((ctrl) =>
      ctrl.spawn(async (proc) => {
        await proc.step((_signal, _step, launchCtrl) => {
          launchCtrl.afterDeliver(() => {
            afterDeliverActor.act((nextCtrl) => {
              nextCtrl.emit({ type: 'after.deliver' });
            });
          });
          return work.promise;
        });
      }),
    );
    await afterDelivered;
    expect(afterDeliverEvents).toEqual([{ type: 'after.deliver' }]);
    work.resolve();
    await afterDeliverRun.done;
    await afterDeliverActor.close();
  });

  it('drains commands queued during closing and settles synchronous close outcomes', async () => {
    type Ev = { readonly type: 'late' };
    let closeCalls = 0;
    const actor = createActor<'idle', Ev>({
      initial: 'idle',
      onClose: () => undefined,
    });
    const bound = actor.bind(() => {
      closeCalls += 1;
    });
    let closing: Promise<void> | undefined;
    actor.act((ctrl) => {
      closing = actor.close();
      ctrl.defer(() => {
        closeCalls += 1;
      });
      bound();
    });
    await closing;
    expect(actor.closed).toBe(true);
    expect(closeCalls).toBe(2);

    const syncClose = createActor<'idle', Ev>({
      initial: 'idle',
      onClose: () => undefined,
    });
    await syncClose.close();
    expect(syncClose.closed).toBe(true);

    const closeError = new Error('sync-close-error');
    const syncThrow = createActor<'idle', Ev>({
      initial: 'idle',
      onClose: () => {
        throw closeError;
      },
    });
    await expect(syncThrow.close()).rejects.toBe(closeError);
    expect(syncThrow.closed).toBe(true);

    const scheduleError = new Error('schedule-error');
    const scheduleFailure = createActor<'idle', Ev>({
      initial: 'idle',
      onSchedule: () => {
        throw scheduleError;
      },
    });
    await expect(scheduleFailure.close()).rejects.toBe(scheduleError);
  });
});


describe('createActor scheduler coverage', () => {
  it('continues checkpoint draining when a predicate wakeup enqueues an event', async () => {
    type Ev = { readonly type: 'injected' };
    const actor = createActor<'idle', Ev>({ initial: 'idle' });
    const events: Ev[] = [];
    actor.subscribe((event) => events.push(event));
    let armed = false;
    let cancellation: unknown;

    const waiting = actor.act((ctrl) =>
      ctrl.spawn(async (proc) => {
        try {
          await proc.waitUntil(() => {
            if (!armed) return false;
            armed = false;
            actor.act((nextCtrl) => {
              nextCtrl.emit({ type: 'injected' });
            });
            return false;
          });
        } catch (error) {
          cancellation = error;
        }
      }),
    );

    let targetProc: ProcessControl<'idle', Ev> | undefined;
    const target = actor.act((ctrl) =>
      ctrl.spawn(async (proc) => {
        targetProc = proc;
      }),
    );
    const blocker = actor.act((ctrl) => ctrl.spawn(async () => undefined));

    armed = true;
    targetProc!.checkpoint();
    expect(events).toEqual([{ type: 'injected' }]);

    waiting.cancel('finish-waiting');
    await Promise.all([waiting.done, target.done, blocker.done]);
    expect(isProcessCancelled(cancellation)).toBe(true);
    await actor.close();
  });

  it('rethrows the first listener error after draining a process segment tail', async () => {
    const microtasks: (() => void)[] = [];
    vi.stubGlobal('queueMicrotask', (task: () => void) => {
      microtasks.push(task);
    });

    try {
      type Ev = { readonly type: 'ping' };
      const actor = createActor<'idle', Ev>({ initial: 'idle' });
      const failure = new Error('listener-tail-failure');
      actor.subscribe(() => {
        throw failure;
      });
      let procRef: ProcessControl<'idle', Ev> | undefined;

      const handle = actor.act((ctrl) =>
        ctrl.spawn(async (proc) => {
          procRef = proc;
          proc.emit({ type: 'ping' });
        }),
      );
      expect(microtasks).toHaveLength(1);

      procRef!.checkpoint();
      procRef!.emit({ type: 'ping' });
      const flush = microtasks.shift()!;
      expect(() => flush()).toThrow(failure);

      await handle.done;
      await actor.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
