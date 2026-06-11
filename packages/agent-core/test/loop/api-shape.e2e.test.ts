/**
 * Type-level lock on the loop's public surface.
 *
 * The point is to make refactors that *unintentionally* widen / narrow /
 * remove a public type a compile error rather than a quiet binary
 * regression. Real behavioural assertions live in the other e2e files;
 * this file is the structural complement to them.
 *
 * Type checks live inside a never-called function body so they run during
 * compile (`tsc --noEmit`) but cost nothing at runtime. A single trivial
 * `it` keeps Vitest happy.
 */

import type { ContentPart, ModelCapability, TokenUsage } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { createLoopEventDispatcher, runTurn, ToolAccesses } from '../../src/loop/index';
import type {
  AfterStepHook,
  BeforeStepResult,
  BeforeStepHook,
  ExecutableTool,
  LLM,
  LLMChatParams,
  LLMChatResponse,
  RunTurnInput,
  ShouldContinueAfterStopHook,
  ShouldContinueAfterStopResult,
  LoopRecordedEvent,
  LoopLiveOnlyEvent,
  LoopEvent,
  LoopHooks,
  LoopInterruptReason,
  LoopLiveEventEmitter,
  LoopMessageBuilder,
  LoopEventDispatcher,
  LoopAfterStepContext,
  LoopStepHookContext,
  LoopTextDeltaEvent,
  LoopThinkingDeltaEvent,
  LoopToolCallDeltaEvent,
  LoopContentPartEvent,
  LoopStepBeginEvent,
  LoopStepEndEvent,
  LoopToolCallEvent,
  LoopToolProgressEvent,
  LoopToolResultEvent,
  LoopTurnInterruptedEvent,
  LoopStepStopReason,
  LoopStoppedStepContext,
  LoopTerminalStepStopReason,
  LoopTurnStopReason,
  StopReason,
  ToolCallDelta,
  ToolCall,
  ExecutableToolContext,
  ToolExecutionHookContext,
  PrepareToolExecutionHook,
  PrepareToolExecutionResult,
  ExecutableToolResult,
  FinalizeToolResultContext,
  FinalizeToolResultHook,
  TurnResult,
} from '../../src/loop/index';

// Compile-time fixtures (never executed).

declare const _llm: LLM;
declare const _buildMessages: LoopMessageBuilder;
declare const _appendTranscriptRecord: (record: LoopRecordedEvent) => Promise<void>;
declare const _emit: LoopLiveEventEmitter;
declare const _dispatchEvent: LoopEventDispatcher;
declare const _signal: AbortSignal;
declare const _hooks: LoopHooks;

function _typeOnlyChecks(): void {
  // RunTurnInput names every external capability explicitly, using
  // function-shaped dependencies when the capability has exactly one method.
  const input: RunTurnInput = {
    turnId: 't1',
    signal: _signal,
    llm: _llm,
    buildMessages: _buildMessages,
    dispatchEvent: _dispatchEvent,
    tools: [],
    hooks: _hooks,
    maxSteps: 2,
  };
  void runTurn(input);

  // Minimal input: tools / hooks / maxSteps are optional.
  const minimalInput: RunTurnInput = {
    turnId: 't1',
    signal: _signal,
    llm: _llm,
    buildMessages: _buildMessages,
    dispatchEvent: _dispatchEvent,
  };
  void minimalInput;

  const createdEventDispatcher = createLoopEventDispatcher({
    appendTranscriptRecord: _appendTranscriptRecord,
    emitLiveEvent: _emit,
  });
  void createdEventDispatcher;

  const chatParams: LLMChatParams = {
    messages: [],
    tools: [],
    signal: _signal,
    onTextDelta: (_delta: string) => {},
    onThinkDelta: (_delta: string) => {},
    onToolCallDelta: (_delta) => {},
    onTextPart: async (_part) => {
      const text: string = _part.text;
      void text;
    },
    onThinkPart: async (_part) => {
      const thinking: string = _part.think;
      void thinking;
    },
  };
  void chatParams;
  const _badChatParamsDelta: LLMChatParams = {
    messages: [],
    tools: [],
    signal: _signal,
    // @ts-expect-error — text deltas use `onTextDelta`, not `onDelta`.
    onDelta: (_delta: string) => {},
  };
  void _badChatParamsDelta;
  const _badChatParamsAtomic: LLMChatParams = {
    messages: [],
    tools: [],
    signal: _signal,
    // @ts-expect-error — completed parts use `onTextPart` / `onThinkPart`.
    onAtomicPart: async (_part: unknown) => {},
  };
  void _badChatParamsAtomic;
  const _badChatParamsContentPart: LLMChatParams = {
    messages: [],
    tools: [],
    signal: _signal,
    // @ts-expect-error — text and thinking parts are split by type.
    onContentPart: async (_part: unknown) => {},
  };
  void _badChatParamsContentPart;

  const chatResponse: LLMChatResponse = {
    toolCalls: [],
    providerFinishReason: 'filtered',
    rawFinishReason: 'content_filter',
    usage: {} as TokenUsage,
  };
  void chatResponse;
  const _badChatResponseStopReason: LLMChatResponse = {
    toolCalls: [],
    usage: {} as TokenUsage,
    // @ts-expect-error - LLM responses expose provider diagnostics; the loop derives stopReason.
    stopReason: 'end_turn',
  };
  void _badChatResponseStopReason;

  // @ts-expect-error — old context/config shape is no longer accepted.
  const _badOldInput: RunTurnInput = { ...input, context: {}, config: {} };
  void _badOldInput;

  // @ts-expect-error — old grouped turn shape is no longer accepted.
  const _badGroupedTurn: RunTurnInput = { ...input, turn: { id: 't1', signal: _signal } };
  void _badGroupedTurn;

  // @ts-expect-error — old events array shape is no longer accepted.
  const _badEvents: RunTurnInput = { ...input, events: [_emit] };
  void _badEvents;

  const _badAppendTranscript: RunTurnInput = {
    ...input,
    // @ts-expect-error — transcript append is now attached to LoopEventDispatcher.
    appendTranscriptRecord: _appendTranscriptRecord,
  };
  void _badAppendTranscript;

  // @ts-expect-error — old emit field is no longer accepted.
  const _badEmit: RunTurnInput = { ...input, emit: _emit };
  void _badEmit;

  // @ts-expect-error — live emit is now attached to LoopEventDispatcher.
  const _badEmitLiveEvent: RunTurnInput = { ...input, emitLiveEvent: _emit };
  void _badEmitLiveEvent;

  // @ts-expect-error — old limits wrapper is no longer accepted.
  const _badLimits: RunTurnInput = { ...input, limits: { maxSteps: 2 } };
  void _badLimits;

  // Messages are built directly; system prompt belongs to LLM.
  const buildMessages: LoopMessageBuilder = () => [];
  void buildMessages;

  // @ts-expect-error — old prompt object wrapper is no longer accepted.
  const _badMessages: LoopMessageBuilder = { buildMessages };
  void _badMessages;

  // Transcript is one append-only recorded event function.
  const appendTranscriptRecord = async (_record: LoopRecordedEvent): Promise<void> => {};
  void appendTranscriptRecord;

  const _badTranscript: (record: LoopRecordedEvent) => Promise<void> = {
    // @ts-expect-error — transcript append is a function, not an object wrapper.
    append: async () => {},
  };
  void _badTranscript;

  const emit: LoopLiveEventEmitter = (_event: LoopEvent) => {};
  void emit;

  const stepBeginRecord: LoopStepBeginEvent = {
    type: 'step.begin',
    uuid: 's1',
    turnId: 't1',
    step: 1,
  };
  const stepEndRecord: LoopStepEndEvent = {
    type: 'step.end',
    uuid: 's1',
    turnId: 't1',
    step: 1,
    finishReason: 'filtered',
    llmFirstTokenLatencyMs: 10,
    llmStreamDurationMs: 20,
    providerFinishReason: 'filtered',
    rawFinishReason: 'content_filter',
  };
  const contentPartRecord: LoopContentPartEvent = {
    type: 'content.part',
    uuid: 'c1',
    turnId: 't1',
    step: 1,
    stepUuid: 's1',
    part: { type: 'text', text: 'hi' },
  };
  const toolCallRecord: LoopToolCallEvent = {
    type: 'tool.call',
    uuid: 'tc1',
    turnId: 't1',
    step: 1,
    stepUuid: 's1',
    toolCallId: 'tc1',
    name: 'echo',
    args: {},
  };
  const toolResultRecord: LoopToolResultEvent = {
    type: 'tool.result',
    parentUuid: 'tc1',
    toolCallId: 'tc1',
    result: { output: 'ok' },
  };
  const _records: LoopRecordedEvent[] = [
    stepBeginRecord,
    stepEndRecord,
    contentPartRecord,
    toolCallRecord,
    toolResultRecord,
  ];
  void _records;

  // Hook contexts receive the LLM directly and no prompt/transcript object.
  const stepHookContext: LoopStepHookContext = {
    turnId: 't1',
    stepNumber: 1,
    signal: _signal,
    llm: _llm,
  };
  void stepHookContext;

  const _badStepHookContext: LoopStepHookContext = {
    turnId: 't1',
    stepNumber: 1,
    signal: _signal,
    llm: _llm,
    // @ts-expect-error — hooks receive `llm`, not a separate modelName field.
    modelName: 'model',
  };
  void _badStepHookContext;

  const afterStepContext: LoopAfterStepContext = {
    ...stepHookContext,
    usage: {} as TokenUsage,
    stopReason: 'tool_use',
  };
  void afterStepContext;

  const stoppedStepContext: LoopStoppedStepContext = {
    ...stepHookContext,
    usage: {} as TokenUsage,
    stopReason: 'filtered',
  };
  void stoppedStepContext;

  const toolCallHookContext: ToolExecutionHookContext = {
    ...stepHookContext,
    toolCall: { type: 'function', id: 'tc1', name: 'echo', arguments: '{}' },
    toolCalls: [{ type: 'function', id: 'tc1', name: 'echo', arguments: '{}' }],
    args: {},
  };
  void toolCallHookContext;

  const _badToolExecutionHookContext: ToolExecutionHookContext = {
    ...stepHookContext,
    toolCall: { type: 'function', id: 'tc1', name: 'echo', arguments: '{}' },
    toolCalls: [{ type: 'function', id: 'tc1', name: 'echo', arguments: '{}' }],
    // @ts-expect-error — tool hooks receive `args`, not the old `input` field.
    input: {},
  };
  void _badToolExecutionHookContext;

  const _badHookContext: ToolExecutionHookContext = {
    ...toolCallHookContext,
    // @ts-expect-error — hooks no longer receive the old big context reader.
    context: buildMessages,
  };
  void _badHookContext;

  // @ts-expect-error — old sink property is no longer accepted.
  const _badInput: RunTurnInput = { ...input, sinks: _emit };
  void _badInput;

  // LoopHooks members are all optional.
  const allHooks: LoopHooks = {
    beforeStep: undefined,
    afterStep: undefined,
    prepareToolExecution: undefined,
    finalizeToolResult: undefined,
    shouldContinueAfterStop: undefined,
  };
  void allHooks;

  // Step stop reasons include provider-visible terminal states and `tool_use`
  // as an intermediate loop-control state.
  const _validStepStops: LoopStepStopReason[] = [
    'end_turn',
    'max_tokens',
    'tool_use',
    'filtered',
    'paused',
    'unknown',
  ];
  void _validStepStops;

  const _validTerminalStepStops: LoopTerminalStepStopReason[] = [
    'end_turn',
    'max_tokens',
    'filtered',
    'paused',
    'unknown',
  ];
  void _validTerminalStepStops;

  // Turn stop reasons exclude `tool_use` because a completed turn never returns
  // while tools are still pending.
  const _validTurnStops: LoopTurnStopReason[] = [
    'end_turn',
    'max_tokens',
    'filtered',
    'paused',
    'unknown',
    'aborted',
  ];
  void _validTurnStops;

  const _deprecatedStopAlias: StopReason[] = [
    'end_turn',
    'max_tokens',
    'tool_use',
    'filtered',
    'paused',
    'unknown',
    'aborted',
  ];
  void _deprecatedStopAlias;

  // @ts-expect-error - stop reasons that flow through throws are not in the union
  const _badStop1: LoopTurnStopReason = 'error';
  void _badStop1;
  // @ts-expect-error - max_steps is represented by a thrown KimiError, not StopReason.
  const _badStop2: LoopTurnStopReason = 'max_steps';
  void _badStop2;
  // @ts-expect-error - tool_use is step-local and cannot be a final turn result.
  const _badStop3: LoopTurnStopReason = 'tool_use';
  void _badStop3;

  // Capability metadata reuses Kosong's provider-facing shape.
  const capability: ModelCapability = {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: true,
    max_context_tokens: 200000,
  };
  const _llmCapability: ModelCapability | undefined = _llm.capability;
  void capability;
  void _llmCapability;

  // ToolCall reuses Kosong's provider-facing function-call shape.
  const toolCall: ToolCall = {
    type: 'function',
    id: 'tc1',
    name: 'echo', arguments: '{"text":"hi"}',
  };
  void toolCall;
  const _badToolCall: ToolCall = {
    name: 'echo',
    // @ts-expect-error — ToolCall has `name` but no `args` property.
    args: {},
  };
  void _badToolCall;

  const toolResultContent: ContentPart[] = [
    { type: 'text', text: 'see image:' },
    { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
  ];
  const structuredToolResult: ExecutableToolResult = { output: toolResultContent };
  void structuredToolResult;

  const executeContext: ExecutableToolContext = {
    turnId: 't1',
    toolCallId: 'tc1',
    signal: _signal,
  };
  void executeContext;
  const _badExecuteContext: ExecutableToolContext = {
    turnId: 't1',
    toolCallId: 'tc1',
    signal: _signal,
    // @ts-expect-error — args are captured by resolveExecution(input), not passed in execute context.
    args: {},
  };
  void _badExecuteContext;

  // ExecutableTool is one object: Kosong's model-visible definition plus resolveExecution().
  const _tool: ExecutableTool = {
    name: 'x',
    description: 'x',
    parameters: { type: 'object' },
    resolveExecution: () => ({
      approvalRule: 'x',
      execute: async (_ctx: ExecutableToolContext) => ({ output: 'ok' }),
    }),
  };
  void _tool;
  const _describableTool: ExecutableTool<{ text: string }> = {
    name: 'x',
    description: 'x',
    parameters: { type: 'object' },
    resolveExecution: (args) => ({
      accesses: ToolAccesses.none(),
      description: `Running ${args.text}`,
      approvalRule: 'x',
      execute: async (_ctx: ExecutableToolContext) => ({ output: 'ok' }),
    }),
  };
  void _describableTool;
  const _badTool: ExecutableTool = {
    name: 'x',
    description: 'x',
    parameters: { type: 'object' },
    resolveExecution: () => ({
      approvalRule: 'x',
      execute: async (_ctx: ExecutableToolContext) => ({ output: 'ok' }),
    }),
    // @ts-expect-error — there is no second Zod schema source on ExecutableTool.
    inputSchema: {},
  };
  void _badTool;

  // Hook function aliases name the phase boundary; LoopHooks stays readable.
  const beforeStepHook: BeforeStepHook = async (ctx) => {
    const llm: LLM = ctx.llm;
    void llm;
    const result: BeforeStepResult = { block: false };
    return result;
  };
  const afterStepHook: AfterStepHook = async (ctx) => {
    const usage: TokenUsage = ctx.usage;
    void usage;
  };
  const prepareToolExecutionHook: PrepareToolExecutionHook = async (ctx) => ({
    updatedArgs: ctx.args,
    executionMetadata: ctx.toolCalls,
  });
  const finalizeToolResultHook: FinalizeToolResultHook = async (ctx) => ctx.result;
  const shouldContinueAfterStopHook: ShouldContinueAfterStopHook = async (ctx) => ({
    continue: ctx.stopReason === 'max_tokens',
  });
  const shouldContinueAfterStopResult: ShouldContinueAfterStopResult = { continue: false };
  void shouldContinueAfterStopResult;
  const hookShapes: LoopHooks = {
    beforeStep: beforeStepHook,
    afterStep: afterStepHook,
    prepareToolExecution: prepareToolExecutionHook,
    finalizeToolResult: finalizeToolResultHook,
    shouldContinueAfterStop: shouldContinueAfterStopHook,
  };
  void hookShapes;

  // LoopEvent is a closed union with the documented variants.
  const _evs: LoopEvent[] = [
    { type: 'step.begin', uuid: 's1', turnId: 't1', step: 1 },
    {
      type: 'step.end',
      uuid: 's1',
      turnId: 't1',
      step: 1,
      llmFirstTokenLatencyMs: 10,
      llmStreamDurationMs: 20,
    },
    {
      type: 'content.part',
      uuid: 'c1',
      turnId: 't1',
      step: 1,
      stepUuid: 's1',
      part: { type: 'text', text: '' },
    },
    { type: 'turn.interrupted', attemptedSteps: 1, activeStep: 1, reason: 'aborted' },
    { type: 'text.delta', delta: '' },
    { type: 'thinking.delta', delta: '' },
    { type: 'tool.call.delta', toolCallId: 'a' },
    {
      type: 'tool.call',
      uuid: 'a',
      turnId: 't1',
      step: 1,
      stepUuid: 's1',
      toolCallId: 'a',
      name: 'x',
      args: {},
    },
    { type: 'tool.progress', toolCallId: 'a', update: { kind: 'stdout' } },
    { type: 'tool.result', parentUuid: 'a', toolCallId: 'a', result: { output: '' } },
  ];
  void _evs;

  // All recorded events are also live events, including completed content parts.
  const _contentPartLiveEvent: LoopEvent = _evs[2] as LoopEvent;
  void _contentPartLiveEvent;

  // TurnResult fields
  const _tr: TurnResult = { stopReason: 'end_turn', steps: 1, usage: {} as TokenUsage };
  void _tr;

  // Cross-reference all named exports just to keep this list in sync
  // with the barrel — adding a new public type without referencing it
  // here will not break anything, but removing one breaks compile.
  type _Exports =
    | AfterStepHook
    | BeforeStepResult
    | BeforeStepHook
    | LLMChatParams
    | LLMChatResponse
    | ShouldContinueAfterStopHook
    | ShouldContinueAfterStopResult
    | LoopContentPartEvent
    | LoopRecordedEvent
    | LoopLiveOnlyEvent
    | LoopEvent
    | LoopLiveEventEmitter
    | LoopInterruptReason
    | LoopMessageBuilder
    | LoopEventDispatcher
    | LoopAfterStepContext
    | LoopStepHookContext
    | LoopStoppedStepContext
    | LoopTerminalStepStopReason
    | LoopStepStopReason
    | LoopTurnStopReason
    | LoopStepBeginEvent
    | LoopStepEndEvent
    | LoopTextDeltaEvent
    | LoopThinkingDeltaEvent
    | LoopToolCallDeltaEvent
    | LoopToolCallEvent
    | LoopToolProgressEvent
    | LoopToolResultEvent
    | LoopTurnInterruptedEvent
    | ToolCallDelta
    | ToolCall
    | ToolExecutionHookContext
    | PrepareToolExecutionHook
    | PrepareToolExecutionResult
    | FinalizeToolResultContext
    | FinalizeToolResultHook
    | TurnResult;
  const _e: _Exports | undefined = undefined;
  void _e;
}
void _typeOnlyChecks;

describe('loop public API shape', () => {
  it('barrel exports the runtime entry points', () => {
    expect(typeof runTurn).toBe('function');
    expect(typeof createLoopEventDispatcher).toBe('function');
  });
});
