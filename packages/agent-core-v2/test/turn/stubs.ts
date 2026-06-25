/**
 * `turn` test stubs — shared `ITurnService` stub for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or `../turn/stubs`).
 */

import { Emitter, type Event } from '#/_base/event';
import type { ServiceRegistration } from '#/_base/di/test';
import { ITurnService } from '#/turn/turn';
import type {
  TurnEndEvent,
  TurnStartEvent,
  TurnStepEvent,
  TurnToolEvent,
  TurnWillExecuteToolEvent,
} from '#/turn/turn';

const noneEvent = (<T>(): Event<T> => () => ({ dispose: () => {} }))();

export interface StubTurnOptions {
  /** Value reported by `hasActiveTurn`. Defaults to `false`. */
  readonly hasActiveTurn?: boolean;
  /** Value reported by `currentId`. Defaults to `undefined`. */
  readonly currentId?: string;
}

/** An `ITurnService` stub that also records `prompt` / `steer` inputs. */
export type StubTurn = ITurnService & {
  readonly prompts: readonly string[];
  readonly steered: readonly string[];
};

/**
 * A configurable `ITurnService` stub. `prompt()` records its input and fires
 * `onDidEndStep` + `onDidEndTurn` to mirror the real turn lifecycle (so
 * subscribers such as compaction / plan observe a full prompt cycle);
 * `hasActiveTurn` / `currentId` are configurable via `options`.
 */
export function stubTurn(options: StubTurnOptions = {}): StubTurn {
  const prompts: string[] = [];
  const steered: string[] = [];
  const endStep = new Emitter<TurnStepEvent>();
  const endTurn = new Emitter<TurnEndEvent>();
  return {
    _serviceBrand: undefined,
    onWillStartTurn: noneEvent as Event<TurnStartEvent>,
    onWillExecuteTool: noneEvent as Event<TurnWillExecuteToolEvent>,
    onDidFinalizeTool: noneEvent as Event<TurnToolEvent>,
    onDidEndStep: endStep.event,
    onDidEndTurn: endTurn.event,
    get hasActiveTurn() {
      return options.hasActiveTurn ?? false;
    },
    get currentId() {
      return options.currentId;
    },
    prompt(input: string) {
      prompts.push(input);
      endStep.fire({ step: 0 } as TurnStepEvent);
      endTurn.fire({ reason: 'completed' } as TurnEndEvent);
      return Promise.resolve();
    },
    steer(content: string) {
      steered.push(content);
    },
    retry() {
      return Promise.resolve();
    },
    cancel() {},
    prompts,
    steered,
  };
}

/**
 * Register the default `ITurnService` stub. Tests that need to inspect
 * `prompts` / `steered` should create their own `stubTurn()` and register it
 * via `additionalServices` instead.
 */
export function registerTurnServices(reg: ServiceRegistration): void {
  reg.defineInstance(ITurnService, stubTurn());
}
