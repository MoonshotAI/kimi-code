import type { LoopEvent, LoopLiveEventEmitter } from '../../../src/loop/index';

export type SinkErrorMode =
  | { kind: 'none' }
  | { kind: 'sync-throw'; onlyAt?: number }
  | { kind: 'async-reject'; onlyAt?: number }
  | { kind: 'every-call-throws' };

export interface CollectingSinkOptions {
  readonly errorMode?: SinkErrorMode | undefined;
  readonly id?: string | undefined;
}

/**
 * Records every event into `events` and supports several injected error
 * modes so tests can assert the loop's listener-failure containment.
 *
 * `LoopLiveEventEmitter` is typed `void`, but LoopEventDispatcher also defends
 * against thenable returns (async listeners). We keep the declared
 * signature `void` and use a runtime cast for the async-reject mode so
 * we exercise the production code path without violating types at the
 * call site.
 */
export class CollectingSink {
  readonly events: LoopEvent[] = [];
  readonly id: string;
  private mode: SinkErrorMode;
  private callCount = 0;

  constructor(opts: CollectingSinkOptions = {}) {
    this.mode = opts.errorMode ?? { kind: 'none' };
    this.id = opts.id ?? 'sink';
  }

  readonly emit: LoopLiveEventEmitter = (event) => {
    const callIndex = this.callCount;
    this.callCount += 1;

    if (this.mode.kind === 'every-call-throws') {
      this.events.push(event);
      throw new Error(`sink ${this.id} fails on every emit`);
    }

    if (
      this.mode.kind === 'sync-throw' &&
      (this.mode.onlyAt === undefined || this.mode.onlyAt === callIndex)
    ) {
      throw new Error(`sink ${this.id} sync throw at call ${String(callIndex)}`);
    }

    if (
      this.mode.kind === 'async-reject' &&
      (this.mode.onlyAt === undefined || this.mode.onlyAt === callIndex)
    ) {
      // Structurally the function returns a rejected promise instead of
      // void; LoopEventDispatcher must contain it.
      const rejected = Promise.reject(
        new Error(`sink ${this.id} async reject at call ${String(callIndex)}`),
      );
      this.events.push(event);
      return rejected as unknown as void;
    }

    this.events.push(event);
  };

  setErrorMode(mode: SinkErrorMode): void {
    this.mode = mode;
  }

  typesIn(): LoopEvent['type'][] {
    return this.events.map((e) => e.type);
  }

  count(type: LoopEvent['type']): number {
    return this.events.filter((e) => e.type === type).length;
  }

  byType<T extends LoopEvent['type']>(type: T): Extract<LoopEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<LoopEvent, { type: T }> => e.type === type);
  }
}
