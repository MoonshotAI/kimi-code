/**
 * `turn` test stubs — shared `IAgentTurnService` stubs for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or `../turn/stubs`).
 */

import type { IAgentLoopService } from '#/agent/loop/loop';
import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { IAgentTurnService, Turn } from '#/agent/turn/turn';
import type { ContentPart } from '#/app/llmProtocol/message';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { createHooks } from '#/hooks';

export interface StubTurnOptions {
  /** When set, `getActiveTurn()` returns a synthetic active turn. */
  readonly hasActiveTurn?: boolean;
  /** Synthetic active turn id (defaults to `0`). Kept for call sites that
   *  previously relied on THEIRS-era `currentId`. */
  readonly currentId?: string | number;
}

/**
 * An `IAgentTurnService` stub that also records `launch` calls and exposes the
 * active turn. `prompts` / `steered` are retained as empty arrays for legacy
 * assertions — the HEAD `IAgentTurnService` has no `prompt` / `steer` methods, so
 * tests that used to drive them should be rewritten against `launch` + hooks.
 */
export type StubTurn = IAgentTurnService & {
  readonly prompts: readonly string[];
  readonly steered: readonly {
    readonly input: readonly ContentPart[];
    readonly origin?: PromptOrigin;
  }[];
  readonly cancels: readonly {
    readonly turnId?: number;
    readonly reason?: unknown;
  }[];
  readonly launches: readonly number[];
};

const turnControllers = new WeakMap<Turn, AbortController>();

function makeTurn(id: number): Turn {
  const controller = new AbortController();
  const turn: Turn = {
    id,
    signal: controller.signal,
    ready: Promise.resolve(),
    result: Promise.resolve({ type: 'completed', steps: 0, truncated: false }),
  };
  turnControllers.set(turn, controller);
  return turn;
}

function makeAgentLoopHookSlots(): IAgentLoopService['hooks'] {
  return createHooks([
    'beforeStep',
    'afterStep',
    'onError',
  ]) as IAgentLoopService['hooks'];
}

/** A configurable `IAgentTurnService` stub backed by real `OrderedHookSlot`s. */
export function stubTurn(options: StubTurnOptions = {}): StubTurn {
  const launches: number[] = [];
  const steered: {
    readonly input: readonly ContentPart[];
    readonly origin?: PromptOrigin;
  }[] = [];
  const cancels: {
    readonly turnId?: number;
    readonly reason?: unknown;
  }[] = [];
  let activeTurn: Turn | undefined;
  let nextId = typeof options.currentId === 'number' ? options.currentId : 0;
  return {
    _serviceBrand: undefined,
    launch() {
      const turn = makeTurn(nextId++);
      launches.push(turn.id);
      activeTurn = turn;
      return turn;
    },
    launchWithLease(lease) {
      const turn = makeTurn(lease.turnId);
      nextId = lease.turnId + 1;
      launches.push(turn.id);
      activeTurn = turn;
      return turn;
    },
    getActiveTurn() {
      return options.hasActiveTurn ? activeTurn : undefined;
    },
    recordSteer(input, origin) {
      steered.push({ input, origin });
    },
    cancel(turnId, reason) {
      cancels.push({ turnId, reason });
      const turn = this.getActiveTurn();
      if (turn === undefined) return false;
      if (turnId !== undefined && turn.id !== turnId) return false;
      turnControllers.get(turn)?.abort(reason);
      return true;
    },
    prompts: [],
    steered,
    cancels,
    launches,
  };
}

/**
 * An `IAgentTurnService` stub backed by real `OrderedHookSlot`s. Use when the system
 * under test registers turn-lifecycle hooks (`onLaunched` / `onEnded`) in its
 * constructor, or when a test needs to drive those hooks directly. `launch`
 * returns a minimal {@link Turn}; `getActiveTurn` is a no-op.
 */
export function stubTurnWithHooks(): IAgentTurnService {
  // Turn-lifecycle hooks moved to `IEventBus`; no service registers turn hooks
  // anymore, so this is now equivalent to `stubTurn()`.
  return stubTurn();
}

/** An `IAgentLoopService` stub backed by real loop lifecycle hook slots. */
export function stubLoopWithHooks(): IAgentLoopService {
  const hooks = makeAgentLoopHookSlots();
  return {
    _serviceBrand: undefined,
    hooks,
    run: async (options) => {
      options.onStarted?.(1);
      return { type: 'completed', steps: 0, truncated: false };
    },
  };
}

/**
 * An `IAgentToolExecutorService` stub whose tool-execution hooks (`onWillExecuteTool` /
 * `onDidExecuteTool`) are real `OrderedHookSlot`s, so services that register
 * gate hooks in their constructor (AgentPermissionGate, AgentMcpService, …) can be built
 * in tests. `execute` yields an empty batch by default.
 */
export function stubToolExecutor(): IAgentToolExecutorService {
  return {
    _serviceBrand: undefined,
    execute: async function* () {},
    hooks: createHooks([
      'onWillExecuteTool',
      'onDidExecuteTool',
    ]) as IAgentToolExecutorService['hooks'],
    registerUnavailableToolDescriber: () => ({ dispose: () => {} }),
    registerMissingToolDescriber: () => ({ dispose: () => {} }),
  };
}
