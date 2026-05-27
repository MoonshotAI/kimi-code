/**
 * Public entry point for the stateless agent loop.
 *
 * Higher-level orchestration may import from this module; this module must not
 * import from host-layer implementations.
 */

export type {
  AfterStepHook,
  BeforeStepResult,
  BeforeStepHook,
  LoopHooks,
  LoopAfterStepContext,
  LoopStepHookContext,
  LoopStepStopReason,
  LoopStoppedStepContext,
  LoopTerminalStepStopReason,
  LoopTurnStopReason,
  StopReason,
  ShouldContinueAfterStopHook,
  ShouldContinueAfterStopResult,
  LoopMessageBuilder,
  ExecutableTool,
  ToolExecution,
  ToolCall,
  ExecutableToolContext,
  ToolExecutionHookContext,
  ResolvedToolExecutionHookContext,
  PrepareToolExecutionHook,
  AuthorizeToolExecutionHook,
  PrepareToolExecutionResult,
  ExecutableToolResult,
  FinalizeToolResultContext,
  FinalizeToolResultHook,
  ToolUpdate,
  TurnResult,
} from './types';

export { ToolAccesses } from './tool-access';

export type {
  CreateLoopEventDispatcherInput,
  LoopContentPartEvent,
  LoopRecordedEvent,
  LoopStepBeginEvent,
  LoopStepEndEvent,
  LoopStepRetryingEvent,
  LoopLiveOnlyEvent,
  LoopEvent,
  LoopInterruptReason,
  LoopLiveEventEmitter,
  LoopEventDispatcher,
  LoopTextDeltaEvent,
  LoopThinkingDeltaEvent,
  LoopToolCallDeltaEvent,
  LoopToolCallEvent,
  LoopToolProgressEvent,
  LoopToolResultEvent,
  LoopTurnInterruptedEvent,
} from './events';
export { createLoopEventDispatcher } from './events';

export type {
  LLM,
  LLMChatParams,
  LLMChatResponse,
  LLMRequestLogContext,
  LLMStreamTiming,
  ToolCallDelta,
} from './llm';

export { runTurn } from './run-turn';
export type { RunTurnInput } from './run-turn';
