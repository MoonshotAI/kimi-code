import type {
  ExecutableTool,
  RunTurnInput,
  LoopHooks,
  LoopLiveEventEmitter,
  TurnResult,
} from '../../../src/loop/index';
import type { Logger } from '../../../src/logging';
import { createLoopEventDispatcher, runTurn as runTurnImpl } from '../../../src/loop/index';
import { CollectingSink, type SinkErrorMode } from './collecting-sink';
import { FakeLLM, type FakeLLMResponse } from './fake-llm';
import { RecordingContext, type RecordingContextOptions } from './recording-context';

export interface RunTurnOptions {
  readonly responses: readonly FakeLLMResponse[];
  readonly tools?: readonly ExecutableTool[] | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly log?: Logger | undefined;
  readonly maxSteps?: number | undefined;
  readonly turnId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly emitLiveEvent?: LoopLiveEventEmitter | undefined;
  readonly llmThrowOnIndex?: { index: number; error: unknown } | undefined;
  readonly llmAbortOnIndex?: { index: number; controller: AbortController } | undefined;
  readonly llmDelayMs?: number | undefined;
  readonly systemPrompt?: string | undefined;
  readonly contextOptions?: RecordingContextOptions | undefined;
  readonly sinkErrorMode?: SinkErrorMode | undefined;
  readonly recordStepUsage?: RunTurnInput['recordStepUsage'] | undefined;
}

export interface RunTurnResult {
  readonly result: TurnResult;
  readonly llm: FakeLLM;
  readonly context: RecordingContext;
  readonly sink: CollectingSink;
}

/**
 * Run one turn end-to-end with sensible defaults. Returns the turn result
 * plus the fixture instances so tests can assert against them.
 */
export async function runTurn(opts: RunTurnOptions): Promise<RunTurnResult> {
  const llm = new FakeLLM({
    responses: opts.responses,
    throwOnIndex: opts.llmThrowOnIndex,
    abortOnIndex: opts.llmAbortOnIndex,
    delayMs: opts.llmDelayMs,
    systemPrompt: opts.systemPrompt,
  });
  const context = new RecordingContext(opts.contextOptions ?? {});
  const fallback = new CollectingSink({ errorMode: opts.sinkErrorMode });
  const sink = fallback;
  const input: RunTurnInput = {
    turnId: opts.turnId ?? 'turn-1',
    signal: opts.signal ?? new AbortController().signal,
    llm,
    buildMessages: context.buildMessages,
    dispatchEvent: createLoopEventDispatcher({
      appendTranscriptRecord: context.appendTranscriptRecord,
      emitLiveEvent: opts.emitLiveEvent ?? fallback.emit,
    }),
    tools: opts.tools,
    hooks: opts.hooks,
    log: opts.log,
    maxSteps: opts.maxSteps,
    recordStepUsage: opts.recordStepUsage,
  };
  const result = await runTurnImpl(input);
  return { result, llm, context, sink };
}

/**
 * Run a turn that's expected to throw, returning the captured error.
 * Throws if the turn returns normally.
 */
export async function runTurnExpectingThrow(opts: RunTurnOptions): Promise<{
  error: unknown;
  llm: FakeLLM;
  context: RecordingContext;
  sink: CollectingSink;
}> {
  const llm = new FakeLLM({
    responses: opts.responses,
    throwOnIndex: opts.llmThrowOnIndex,
    abortOnIndex: opts.llmAbortOnIndex,
    delayMs: opts.llmDelayMs,
    systemPrompt: opts.systemPrompt,
  });
  const context = new RecordingContext(opts.contextOptions ?? {});
  const fallback = new CollectingSink({ errorMode: opts.sinkErrorMode });
  const sink = fallback;
  const input: RunTurnInput = {
    turnId: opts.turnId ?? 'turn-1',
    signal: opts.signal ?? new AbortController().signal,
    llm,
    buildMessages: context.buildMessages,
    dispatchEvent: createLoopEventDispatcher({
      appendTranscriptRecord: context.appendTranscriptRecord,
      emitLiveEvent: opts.emitLiveEvent ?? fallback.emit,
    }),
    tools: opts.tools,
    hooks: opts.hooks,
    log: opts.log,
    maxSteps: opts.maxSteps,
    recordStepUsage: opts.recordStepUsage,
  };
  try {
    await runTurnImpl(input);
  } catch (error) {
    return { error, llm, context, sink };
  }
  throw new Error('runTurnExpectingThrow: expected throw, got resolution');
}

/**
 * Find the index of a kind in `recording.kinds()`, throwing a clear
 * error if it's missing. Helpful for adjacency-pair assertions.
 */
export function indexOfKind(kinds: readonly string[], kind: string, fromIndex = 0): number {
  for (let i = fromIndex; i < kinds.length; i += 1) {
    if (kinds[i] === kind) return i;
  }
  throw new Error(`indexOfKind: missing "${kind}" in [${kinds.join(',')}]`);
}

/**
 * Assert that one kind appears immediately before another (for ordering
 * assertions that aren't full-sequence snapshots).
 */
export function assertImmediatelyBefore(
  kinds: readonly string[],
  earlier: string,
  later: string,
): void {
  const i = indexOfKind(kinds, earlier);
  if (kinds[i + 1] !== later) {
    throw new Error(
      `expected "${earlier}" to be immediately followed by "${later}", got "${
        kinds[i + 1] ?? '<end>'
      }". full: [${kinds.join(',')}]`,
    );
  }
}
