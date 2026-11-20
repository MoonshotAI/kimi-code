import { createAbortScope, withAbort } from '#/utils/abort';
import { waitEvent, type WaitOpts } from '#/utils/wait';
import type {
  Actor,
  ActorControl,
  ActorEvent,
  ActorOptions,
  EventOf,
  ProcessControl,
  ProcessHandle,
  StepControl,
} from './types';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export class ProcessCancelledError extends Error {
  readonly reason: unknown;

  constructor(reason?: unknown) {
    super('Actor process cancelled');
    this.name = 'ProcessCancelledError';
    this.reason = reason;
  }
}

export function isProcessCancelled(error: unknown): error is ProcessCancelledError {
  return error instanceof ProcessCancelledError;
}

interface PredicateWaiter {
  readonly check: () => boolean;
  readonly wake: () => void;
}

interface InternalProcess {
  inSegment: boolean;
  readonly cancel: (reason?: unknown) => void;
}

export function createActor<TState, TEvent extends ActorEvent = never>(
  options: ActorOptions<TState, TEvent>,
): Actor<TState, TEvent> {
  const rootScope = createAbortScope();
  const listeners = new Set<(event: TEvent) => void>();
  const idleWaiters = new Set<() => void>();
  const processes = new Set<InternalProcess>();
  const waitPredicates = new Set<PredicateWaiter>();
  const commands: (() => void)[] = [];
  const continuations: (() => void)[] = [];
  const events: TEvent[] = [];
  const afterDeliverQueue: (() => void)[] = [];

  let state = options.initial;
  let kicking = false;
  let dispatching = false;
  let mutating = false;
  let flushingCheckpoint = false;
  let closing = false;
  let closeHandlerDone = false;
  let closeSettled = false;
  let closeError: { readonly error: unknown } | undefined;
  let closeCompletion: Deferred<void> | undefined;
  let pendingFailure: { readonly error: unknown } | undefined;

  const captureFailure = (error: unknown): void => {
    if (pendingFailure === undefined) pendingFailure = { error };
  };

  const anyProcessInSegment = (): boolean => {
    for (const proc of processes) {
      if (proc.inSegment) return true;
    }
    return false;
  };

  const assertOpen = (): void => {
    if (closeSettled) {
      throw new Error('Actor is closed');
    }
  };

  const emitRaw = <E extends TEvent>(event: E): E => {
    options.onEmit?.(event);
    events.push(event);
    return event;
  };

  const deferRaw = (fn: (ctrl: ActorControl<TState, TEvent>) => void): void => {
    commands.push(() => {
      withTurnControl(fn);
    });
  };

  const bindRaw = <Args extends unknown[]>(
    fn: (ctrl: ActorControl<TState, TEvent>, ...args: Args) => void,
  ): ((...args: Args) => void) => {
    return (...args: Args) => {
      if (closeSettled) return;
      commands.push(() => {
        withTurnControl((ctrl) => {
          fn(ctrl, ...args);
        });
      });
      kick();
    };
  };

  const createScopedControl = (isValid: () => boolean): ActorControl<TState, TEvent> => {
    const guard = (): void => {
      assertOpen();
      if (!isValid()) {
        throw new Error('ActorControl cannot be used outside its active synchronous turn');
      }
    };
    return {
      get state() {
        return state;
      },
      get rootSignal() {
        return rootScope.signal;
      },
      setState(next) {
        guard();
        state = next;
      },
      emit(event) {
        guard();
        return emitRaw(event);
      },
      defer(fn) {
        guard();
        deferRaw(fn);
      },
      bind(fn) {
        guard();
        return bindRaw(fn);
      },
      afterDeliver(fn) {
        guard();
        afterDeliverQueue.push(fn);
      },
      spawn(runner) {
        guard();
        return spawnInternal(runner);
      },
    };
  };

  const withTurnControl = <R>(fn: (ctrl: ActorControl<TState, TEvent>) => R): R => {
    assertOpen();
    let valid = true;
    const ctrl = createScopedControl(() => valid);
    try {
      return fn(ctrl);
    } finally {
      valid = false;
    }
  };

  const scheduleSegmentTailFlush = (internal: InternalProcess): void => {
    queueMicrotask(() => {
      if (closeSettled) return;
      if (events.length === 0 && afterDeliverQueue.length === 0 && commands.length === 0) return;
      const wasInSegment = internal.inSegment;
      internal.inSegment = false;
      try {
        drainCheckpoint();
      } finally {
        internal.inSegment = wasInSegment;
      }
      settleIdle();
      settleClose();
      if (pendingFailure !== undefined) {
        const thrown = pendingFailure.error;
        pendingFailure = undefined;
        throw thrown;
      }
    });
  };

  const spawnInternal = (
    runner: (proc: ProcessControl<TState, TEvent>) => Promise<void>,
  ): ProcessHandle => {
    const procScope = withAbort(rootScope.signal);
    const doneDeferred = deferred<void>();
    let cancelled = false;
    let cancelReason: unknown;
    let cancelCount = 0;
    let active = true;
    let onCancelCurrentSuspension: ((reason: unknown, count: number) => void) | undefined;

    const internal: InternalProcess = {
      inSegment: true,
      cancel(reason?: unknown) {
        cancelCount += 1;
        if (!cancelled) {
          cancelled = true;
          cancelReason = reason;
          procScope.abort(reason);
        }
        onCancelCurrentSuspension?.(cancelReason, cancelCount);
      },
    };
    processes.add(internal);

    const guardProcessSegment = (): void => {
      assertOpen();
      if (!active || !internal.inSegment) {
        throw new Error('ProcessControl cannot be used while suspended or after completion');
      }
    };

    const checkpoint = (): void => {
      guardProcessSegment();
      internal.inSegment = false;
      try {
        drainCheckpoint();
      } finally {
        internal.inSegment = true;
      }
      if (cancelled) {
        throw new ProcessCancelledError(cancelReason);
      }
    };

    const suspendWaitUntil = (predicate: () => boolean): Promise<void> => {
      guardProcessSegment();
      if (events.length > 0 || afterDeliverQueue.length > 0 || commands.length > 0) {
        checkpoint();
      } else if (cancelled) {
        return Promise.reject(new ProcessCancelledError(cancelReason));
      }
      if (predicate()) {
        return Promise.resolve();
      }
      const gate = deferred<void>();
      internal.inSegment = false;
      let settled = false;

      const waiter: PredicateWaiter = {
        check: predicate,
        wake: () => {
          if (settled) return;
          settled = true;
          waitPredicates.delete(waiter);
          onCancelCurrentSuspension = undefined;
          continuations.push(() => {
            internal.inSegment = true;
            if (cancelled) {
              gate.reject(new ProcessCancelledError(cancelReason));
            } else {
              gate.resolve();
            }
            scheduleSegmentTailFlush(internal);
          });
        },
      };

      onCancelCurrentSuspension = () => {
        settled = true;
        waitPredicates.delete(waiter);
        onCancelCurrentSuspension = undefined;
        continuations.push(() => {
          internal.inSegment = true;
          gate.reject(new ProcessCancelledError(cancelReason));
          scheduleSegmentTailFlush(internal);
        });
        kick();
      };

      waitPredicates.add(waiter);
      kick();
      return gate.promise;
    };

    const suspendStep = <R>(
      hasNextState: boolean,
      nextState: TState | undefined,
      task: (
        signal: AbortSignal,
        step: StepControl<TState, TEvent, R>,
        control: ActorControl<TState, TEvent>,
      ) => Promise<R> | R,
    ): Promise<R> => {
      guardProcessSegment();
      if (cancelled) {
        return Promise.reject(new ProcessCancelledError(cancelReason));
      }
      if (hasNextState) {
        state = nextState as TState;
      }
      const gate = deferred<R>();
      internal.inSegment = false;

      let started = false;
      let settled = false;
      const stepScope = withAbort(procScope.signal);
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const cleanups: (() => void)[] = [];
      let customCancel:
        | ((control: ActorControl<TState, TEvent>, reason: unknown, count: number) => void)
        | undefined;
      const doneGate = deferred<R>();
      void doneGate.promise.catch(() => undefined);

      const cleanupStep = (): void => {
        onCancelCurrentSuspension = undefined;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        const registered = cleanups.splice(0).toReversed();
        try {
          for (const cleanup of registered) cleanup();
        } finally {
          stepScope.abort(cancelReason);
        }
      };

      const finishStep = (kind: 'resolve' | 'reject' | 'cancel', payload: unknown): void => {
        if (settled) return;
        settled = true;
        cleanupStep();
        if (kind === 'resolve') doneGate.resolve(payload as R);
        else if (kind === 'reject') doneGate.reject(payload);
        else doneGate.reject(new ProcessCancelledError(payload));

        continuations.push(() => {
          internal.inSegment = true;
          if (kind === 'resolve') gate.resolve(payload as R);
          else if (kind === 'reject') gate.reject(payload);
          else gate.reject(new ProcessCancelledError(payload));
          scheduleSegmentTailFlush(internal);
        });
        kick();
      };

      onCancelCurrentSuspension = (reason, count) => {
        if (!started) {
          finishStep('cancel', reason);
          return;
        }
        if (customCancel !== undefined) {
          withTurnControl((ctrl) => {
            customCancel?.(ctrl, reason, count);
          });
          return;
        }
        finishStep('cancel', reason);
      };

      const stepControl: StepControl<TState, TEvent, R> = {
        get signal() {
          return stepScope.signal;
        },
        get done() {
          return doneGate.promise;
        },
        resolve(value: R) {
          finishStep('resolve', value);
        },
        reject(error: unknown) {
          finishStep('reject', error);
        },
        after(delayMs, fn) {
          if (settled) return () => undefined;
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (closeSettled) return;
            commands.push(() => {
              if (settled) return;
              withTurnControl(fn);
            });
            kick();
          }, Math.max(0, delayMs));
          timers.add(timer);
          return () => {
            if (!timers.delete(timer)) return;
            clearTimeout(timer);
          };
        },
        bind(fn) {
          return (...args) => {
            if (settled || closeSettled) return;
            commands.push(() => {
              if (settled) return;
              withTurnControl((ctrl) => {
                fn(ctrl, ...args);
              });
            });
            kick();
          };
        },
        onCancel(handler) {
          customCancel = handler;
        },
        onExit(cleanup) {
          if (settled) return;
          cleanups.push(cleanup);
        },
      };

      continuations.push(() => {
        if (settled) return;
        started = true;
        void (async () => {
          try {
            let taskPromise: Promise<R> | R;
            let launchValid = true;
            const launchCtrl = createScopedControl(() => launchValid && !settled);
            try {
              taskPromise = task(stepScope.signal, stepControl, launchCtrl);
            } finally {
              launchValid = false;
            }
            const value = await taskPromise;
            finishStep('resolve', value);
          } catch (error) {
            finishStep('reject', error);
          }
        })();
      });

      kick();
      return gate.promise;
    };

    const procBase = createScopedControl(() => active && internal.inSegment);

    const procControl: ProcessControl<TState, TEvent> = {
      get state() {
        return procBase.state;
      },
      get rootSignal() {
        return procBase.rootSignal;
      },
      get signal() {
        return procScope.signal;
      },
      get cancelled() {
        return cancelled;
      },
      get cancelReason() {
        return cancelReason;
      },
      get cancelCount() {
        return cancelCount;
      },
      setState: (next) => procBase.setState(next),
      emit: (event) => procBase.emit(event),
      defer: (fn) => procBase.defer(fn),
      bind: (fn) => procBase.bind(fn),
      afterDeliver: (fn) => procBase.afterDeliver(fn),
      spawn: (child) => procBase.spawn(child),
      checkpoint,
      waitUntil: suspendWaitUntil,
      step<R>(
        first:
          | TState
          | ((
              signal: AbortSignal,
              step: StepControl<TState, TEvent, NoInfer<R>>,
              control: ActorControl<TState, TEvent>,
            ) => Promise<R> | R),
        second?: (
          signal: AbortSignal,
          step: StepControl<TState, TEvent, NoInfer<R>>,
          control: ActorControl<TState, TEvent>,
        ) => Promise<R> | R,
      ): Promise<R> {
        if (second !== undefined) {
          return suspendStep(
            true,
            first as TState,
            second as (
              signal: AbortSignal,
              step: StepControl<TState, TEvent, R>,
              control: ActorControl<TState, TEvent>,
            ) => Promise<R> | R,
          );
        }
        return suspendStep(
          false,
          undefined,
          first as (
            signal: AbortSignal,
            step: StepControl<TState, TEvent, R>,
            control: ActorControl<TState, TEvent>,
          ) => Promise<R> | R,
        );
      },
    };

    void (async () => {
      try {
        const startPromise = runner(procControl);
        if (internal.inSegment) {
          scheduleSegmentTailFlush(internal);
        }
        await startPromise;
      } catch (error) {
        if (!isProcessCancelled(error)) {
          if (options.onError !== undefined && !closeSettled) {
            try {
              withTurnControl((ctrl) => {
                options.onError?.(ctrl, error);
              });
            } catch (handlerError) {
              captureFailure(handlerError);
            }
          } else {
            captureFailure(error);
          }
        }
      } finally {
        active = false;
        internal.inSegment = false;
        onCancelCurrentSuspension = undefined;
        processes.delete(internal);
        doneDeferred.resolve();
        kick();
      }
    })();

    return {
      get signal() {
        return procScope.signal;
      },
      get cancelled() {
        return cancelled;
      },
      get cancelReason() {
        return cancelReason;
      },
      get cancelCount() {
        return cancelCount;
      },
      get active() {
        return active;
      },
      get done() {
        return doneDeferred.promise;
      },
      cancel(reason?: unknown) {
        if (closeSettled || !active) return;
        if (dispatching) {
          commands.push(() => {
            internal.cancel(reason);
          });
          return;
        }
        const outerMutating = mutating;
        mutating = true;
        try {
          internal.cancel(reason);
        } finally {
          mutating = outerMutating;
        }
        kick();
      },
    };
  };

  const wakePredicates = (): void => {
    if (waitPredicates.size === 0) return;
    for (const waiter of Array.from(waitPredicates)) {
      if (waiter.check()) waiter.wake();
    }
  };

  const drainEvents = (): void => {
    if (dispatching || events.length === 0) return;
    dispatching = true;
    try {
      const batch = events.splice(0);
      for (const event of batch) {
        for (const listener of Array.from(listeners)) {
          try {
            listener(event);
          } catch (error) {
            if (options.onListenerError === undefined) captureFailure(error);
            else {
              try {
                options.onListenerError(error, event);
              } catch (listenerError) {
                captureFailure(listenerError);
              }
            }
          }
        }
      }
    } finally {
      dispatching = false;
    }
  };

  const runAfterDeliver = (): void => {
    if (afterDeliverQueue.length === 0) return;
    const callbacks = afterDeliverQueue.splice(0);
    for (const fn of callbacks) fn();
  };

  const runSchedule = (): void => {
    if (closing || closeSettled || options.onSchedule === undefined) return;
    withTurnControl((ctrl) => {
      options.onSchedule?.(ctrl);
    });
  };

  const drainCheckpoint = (): void => {
    if (dispatching || mutating || flushingCheckpoint) return;
    flushingCheckpoint = true;
    try {
      while (true) {
        runSchedule();
        drainEvents();
        runAfterDeliver();
        const nextCommand = commands.shift();
        if (nextCommand !== undefined) {
          nextCommand();
          continue;
        }
        wakePredicates();
        if (events.length > 0 || afterDeliverQueue.length > 0 || commands.length > 0) continue;
        break;
      }
    } finally {
      flushingCheckpoint = false;
    }
  };

  const isQuiescent = (): boolean =>
    !kicking &&
    !dispatching &&
    !mutating &&
    !anyProcessInSegment() &&
    events.length === 0 &&
    afterDeliverQueue.length === 0 &&
    commands.length === 0 &&
    continuations.length === 0;

  const isIdleNow = (): boolean => {
    if (processes.size > 0) return false;
    return options.isIdle === undefined ? true : options.isIdle(state);
  };

  const settleIdle = (): void => {
    if (idleWaiters.size === 0 || !isQuiescent() || !isIdleNow()) return;
    const waiters = Array.from(idleWaiters);
    idleWaiters.clear();
    for (const resolve of waiters) resolve();
  };

  const settleClose = (): void => {
    if (
      closeCompletion === undefined ||
      closeSettled ||
      !closing ||
      !closeHandlerDone ||
      processes.size > 0 ||
      !isQuiescent()
    ) {
      return;
    }
    closeSettled = true;
    rootScope.abort('closed');
    if (closeError !== undefined) {
      closeCompletion.reject(closeError.error);
    } else {
      closeCompletion.resolve();
    }
  };

  const kick = (): void => {
    if (kicking || dispatching || mutating || anyProcessInSegment()) return;
    kicking = true;
    try {
      while (true) {
        runSchedule();
        if (anyProcessInSegment()) break;

        drainEvents();
        runAfterDeliver();

        const nextCommand = commands.shift();
        if (nextCommand !== undefined) {
          nextCommand();
          if (anyProcessInSegment()) break;
          continue;
        }

        wakePredicates();

        const nextContinuation = continuations.shift();
        if (nextContinuation !== undefined) {
          nextContinuation();
          if (anyProcessInSegment()) break;
          continue;
        }

        if (events.length > 0 || afterDeliverQueue.length > 0 || commands.length > 0) continue;
        break;
      }
    } finally {
      kicking = false;
      settleIdle();
      settleClose();
    }
    if (pendingFailure !== undefined) {
      const thrown = pendingFailure.error;
      pendingFailure = undefined;
      throw thrown;
    }
  };

  return {
    get state() {
      return state;
    },
    get closing() {
      return closing;
    },
    get closed() {
      return closeSettled;
    },
    act<R>(fn: (ctrl: ActorControl<TState, TEvent>) => R): R {
      assertOpen();
      const outerMutating = mutating;
      mutating = true;
      let result: R;
      try {
        result = withTurnControl(fn);
      } finally {
        mutating = outerMutating;
      }
      kick();
      return result;
    },
    bind: bindRaw,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    wait<K extends TEvent['type']>(
      type: K,
      opts?: WaitOpts<EventOf<TEvent, K>>,
    ): Promise<EventOf<TEvent, K>> {
      return waitEvent<EventOf<TEvent, K>>(
        (handler) =>
          this.subscribe((event) => {
            if (event.type === type) handler(event as EventOf<TEvent, K>);
          }),
        opts,
      );
    },
    waitForIdle(): Promise<void> {
      if (isQuiescent() && isIdleNow()) return Promise.resolve();
      return new Promise((resolve) => {
        idleWaiters.add(resolve);
      });
    },
    close(): Promise<void> {
      if (closeCompletion !== undefined) return closeCompletion.promise;
      const completion = deferred<void>();
      closeCompletion = completion;
      try {
        commands.push(() => {
          closing = true;
          if (options.onClose === undefined) {
            for (const proc of Array.from(processes)) {
              proc.cancel('closed');
            }
            rootScope.abort('closed');
            closeHandlerDone = true;
            return;
          }
          let maybePromise: Promise<void> | void;
          try {
            maybePromise = withTurnControl((ctrl) => options.onClose?.(ctrl));
          } catch (error) {
            closeError = { error };
            closeHandlerDone = true;
            rootScope.abort('closed');
            return;
          }
          rootScope.abort('closed');
          if (maybePromise === undefined) {
            closeHandlerDone = true;
            return;
          }
          void (async () => {
            try {
              await maybePromise;
            } catch (error) {
              closeError = { error };
            } finally {
              closeHandlerDone = true;
              kick();
            }
          })();
        });
        kick();
      } catch (error) {
        completion.reject(error);
      }
      return completion.promise;
    },
  };
}
