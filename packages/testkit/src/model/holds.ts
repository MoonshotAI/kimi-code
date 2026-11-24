import { TestkitError } from '#/errors';
import { TIMEOUTS } from '#/fixtures/timeouts';
import type { ModelRequest, WaitOptions } from '#/model/types';
import { waitForModelEvent } from '#/model/wait';

export type HoldOutcome =
  | { readonly type: 'release' }
  | { readonly type: 'fail'; readonly status: number }
  | { readonly type: 'cut' };

export type HoldResult = HoldOutcome | { readonly type: 'stopped' };

export interface Hold {
  readonly name: string;
  readonly isReached: boolean;
  readonly isSettled: boolean;
  reached(options?: WaitOptions): Promise<ModelRequest>;
  release(): void;
  fail(status?: number): void;
  cut(): void;
}

interface HoldState {
  readonly name: string;
  claimedBy?: string;
  beforeUnit?: number;
  request?: ModelRequest;
  outcome?: HoldOutcome;
  automatic: boolean;
  readonly reachedListeners: Set<(request: ModelRequest) => void>;
  readonly outcomeListeners: Set<(outcome: HoldOutcome) => void>;
}

export class HoldRegistry {
  private readonly states = new Map<string, HoldState>();

  constructor(private readonly closing: AbortSignal) {}

  handle(name: string): Hold {
    const state = this.state(name);
    return {
      name,
      get isReached() {
        return state.request !== undefined;
      },
      get isSettled() {
        return state.outcome !== undefined;
      },
      reached: (options = {}) => this.reached(state, options.timeoutMs ?? TIMEOUTS.request),
      release: () => this.settle(state, { type: 'release' }),
      fail: (status = 500) => {
        if (state.beforeUnit !== undefined && state.beforeUnit > 0) {
          throw failAfterHeaders(name, state.beforeUnit, status);
        }
        this.settle(state, { type: 'fail', status });
      },
      cut: () => this.settle(state, { type: 'cut' }),
    };
  }

  claim(name: string, beforeUnit: number, label: string): void {
    const state = this.state(name);
    if (state.claimedBy !== undefined) {
      throw new TestkitError(`Hold ${JSON.stringify(name)} is already used by ${state.claimedBy}; give every held() step its own name`);
    }
    if (state.outcome?.type === 'fail' && beforeUnit > 0) throw failAfterHeaders(name, beforeUnit, state.outcome.status);
    state.claimedBy = label;
    state.beforeUnit = beforeUnit;
  }

  automatic(name: string): void {
    const state = this.state(name);
    state.automatic = true;
    state.claimedBy = 'an unscripted request';
    state.beforeUnit = 1;
  }

  arrive(name: string, request: ModelRequest, gone: AbortSignal): Promise<HoldResult> {
    const state = this.state(name);
    state.request = request;
    for (const notify of state.reachedListeners) notify(request);
    if (state.outcome !== undefined) return Promise.resolve(state.outcome);
    if (this.closing.aborted || gone.aborted) return Promise.resolve({ type: 'stopped' });
    return new Promise<HoldResult>((resolve) => {
      const finish = (result: HoldResult): void => {
        state.outcomeListeners.delete(onOutcome);
        this.closing.removeEventListener('abort', onStopped);
        gone.removeEventListener('abort', onStopped);
        resolve(result);
      };
      const onOutcome = (outcome: HoldOutcome): void => finish(outcome);
      const onStopped = (): void => finish({ type: 'stopped' });
      state.outcomeListeners.add(onOutcome);
      this.closing.addEventListener('abort', onStopped, { once: true });
      gone.addEventListener('abort', onStopped, { once: true });
    });
  }

  releaseReached(): void {
    for (const state of this.states.values()) {
      if (state.request !== undefined) this.settle(state, { type: 'release' });
    }
  }

  unsettled(): Array<{ readonly name: string; readonly request: ModelRequest }> {
    const result: Array<{ readonly name: string; readonly request: ModelRequest }> = [];
    for (const state of this.states.values()) {
      if (state.automatic || state.outcome !== undefined || state.request === undefined) continue;
      if (state.request.state !== 'held') continue;
      result.push({ name: state.name, request: state.request });
    }
    return result;
  }

  private reached(state: HoldState, timeoutMs: number): Promise<ModelRequest> {
    if (state.request !== undefined) return Promise.resolve(state.request);
    return waitForModelEvent<ModelRequest>(
      this.closing,
      (settle) => {
        state.reachedListeners.add(settle);
        return () => state.reachedListeners.delete(settle);
      },
      { timeoutMs, describe: () => `a request to reach hold ${JSON.stringify(state.name)}` },
    );
  }

  private settle(state: HoldState, outcome: HoldOutcome): void {
    if (state.outcome !== undefined) return;
    state.outcome = outcome;
    for (const notify of state.outcomeListeners) notify(outcome);
  }

  private state(name: string): HoldState {
    let state = this.states.get(name);
    if (state === undefined) {
      state = { name, automatic: false, reachedListeners: new Set(), outcomeListeners: new Set() };
      this.states.set(name, state);
    }
    return state;
  }
}

function failAfterHeaders(name: string, beforeUnit: number, status: number): TestkitError {
  return new TestkitError(
    `Hold ${JSON.stringify(name)} pauses before unit ${beforeUnit}, after the response headers are sent, so fail(${status}) cannot send an error status; hold before unit 0 to fail, use cut() to drop the stream, or script streamError()`,
  );
}
