import type { EngineEvent } from '../sdk-local/types';

import type { LegacyWireEvent, StatusUpdate, TurnBegin } from '../../shared/legacy-sdk';
import type { ErrorPhase, UIStreamEvent } from '../../shared/types';

const DEFAULT_MAIN_AGENT_ID = 'main';

export interface EventAdapterState {
  /** `llm.step.begin` sequence within the current turn, fed to `StepBegin.n`.
   *  The engine emits no step numbers, so the adapter numbers them itself. */
  readonly stepCount: number;
}

export type TurnTerminalReason = 'completed' | 'cancelled' | 'failed';

export interface TurnTerminalMetadata {
  /** Stable within one adapter stream and suitable for terminal-event de-duplication. */
  readonly key: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: number;
  readonly reason: TurnTerminalReason;
}

export interface EventAdapterResult {
  readonly state: EventAdapterState;
  readonly event?: UIStreamEvent;
  /** SessionRuntime owns conversion of this metadata to exactly one complete/error event. */
  readonly terminal?: TurnTerminalMetadata;
}

export interface AdaptSdkEventOptions {
  /** The engine turn-start event intentionally does not repeat prompt content. */
  readonly pendingInput?: TurnBegin['user_input'];
  readonly mainAgentId?: string;
  readonly errorPhase?: ErrorPhase;
}

export function createEventAdapterState(): EventAdapterState {
  return { stepCount: 0 };
}

/**
 * Purely projects one Rust-engine event (passed through by the SDK) into the
 * released Webview protocol. The SDK routes only this session's events here
 * and stamps `agentId: 'main'`, so no subagent routing is needed. The
 * returned state must be passed into the next call; the input state is never
 * mutated.
 */
export function adaptSdkEvent(
  state: EventAdapterState,
  sdkEvent: EngineEvent,
  options: AdaptSdkEventOptions = {},
): EventAdapterResult {
  const mainAgentId = options.mainAgentId ?? DEFAULT_MAIN_AGENT_ID;

  if (sdkEvent.type === 'session.turn.started') {
    const nextState = { stepCount: 0 };
    if (sdkEvent.agentId !== mainAgentId || options.pendingInput === undefined) {
      return { state: nextState };
    }
    return {
      state: nextState,
      event: withSessionId(
        {
          type: 'TurnBegin',
          payload: { user_input: options.pendingInput },
        },
        sdkEvent.sessionId,
      ),
    };
  }

  if (sdkEvent.type === 'session.turn.ended') {
    if (sdkEvent.agentId !== mainAgentId) return { state };
    return {
      state,
      terminal: {
        key: `${sdkEvent.sessionId}:${sdkEvent.agentId}:${sdkEvent.turn_id}`,
        sessionId: sdkEvent.sessionId,
        agentId: sdkEvent.agentId,
        turnId: sdkEvent.turn_id ?? 0,
        reason: mapStopReason(sdkEvent.stop_reason ?? ''),
      },
    };
  }

  if (sdkEvent.type === 'error') {
    if (sdkEvent.agentId !== mainAgentId) return { state };
    return {
      state,
      event: {
        type: 'error',
        code: sdkEvent.code ?? 'internal',
        message: sdkEvent.message ?? '',
        detail: serializeDetails(sdkEvent.details as Record<string, unknown> | undefined),
        phase: options.errorPhase ?? 'runtime',
        _sessionId: sdkEvent.sessionId,
      },
    };
  }

  const mapped = mapEngineEvent(state, sdkEvent);
  if (mapped.event === undefined) return { state: mapped.state };

  return {
    state: mapped.state,
    event: withSessionId(mapped.event, sdkEvent.sessionId),
  };
}

export function toLegacyToolName(name: string): string {
  switch (name) {
    case 'Bash':
      return 'Shell';
    case 'Read':
      return 'ReadFile';
    case 'Write':
      return 'WriteFile';
    case 'Edit':
      return 'StrReplaceFile';
    case 'TodoList':
      return 'SetTodoList';
    default:
      return name;
  }
}

interface MappedLegacyWireEvent {
  readonly state: EventAdapterState;
  readonly event?: LegacyWireEvent;
}

function mapEngineEvent(
  state: EventAdapterState,
  sdkEvent: EngineEvent,
): MappedLegacyWireEvent {
  switch (sdkEvent.type) {
    case 'llm.step.begin':
      return {
        state: { stepCount: state.stepCount + 1 },
        event: { type: 'StepBegin', payload: { n: state.stepCount + 1 } },
      };
    case 'llm.delta': {
      const part = sdkEvent.part;
      if (part !== undefined && part.type === 'text' && part.text !== undefined && part.text.length > 0) {
        return {
          state,
          event: { type: 'ContentPart', payload: { type: 'text', text: part.text } },
        };
      }
      if (part !== undefined && part.type === 'think' && part.think !== undefined && part.think.length > 0) {
        return {
          state,
          event: { type: 'ContentPart', payload: { type: 'think', think: part.think } },
        };
      }
      // `tool_call` parts are dropped: `session.tool.started` already carries
      // the complete arguments for the Webview's ToolCall card.
      return { state };
    }
    case 'llm.step.end': {
      const usage = sdkEvent.usage;
      if (usage === undefined) return { state };
      const payload: StatusUpdate = {
        token_usage: {
          input_other: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          input_cache_read: 0,
          input_cache_creation: 0,
        },
      };
      return { state, event: { type: 'StatusUpdate', payload } };
    }
    case 'session.tool.started':
      return {
        state,
        event: {
          type: 'ToolCall',
          payload: {
            type: 'function',
            id: sdkEvent.tool_call_id,
            function: {
              name: toLegacyToolName(sdkEvent.tool_name ?? ''),
              arguments: serializeArguments(sdkEvent.arguments),
            },
          },
        },
      };
    case 'session.tool.settled':
      return {
        state,
        event: {
          type: 'ToolResult',
          payload: {
            tool_call_id: sdkEvent.tool_call_id,
            return_value: {
              is_error: sdkEvent.is_error,
              output: sdkEvent.content,
              message: '',
              display: [],
            },
          },
        },
      };
    case 'session.hook.result':
      return {
        state,
        event: { type: 'ContentPart', payload: { type: 'text', text: sdkEvent.content } },
      };
    case 'session.compaction.started':
      return {
        state,
        event: { type: 'CompactionBegin', payload: {} },
      };
    default:
      return { state };
  }
}

function mapStopReason(stopReason: string): TurnTerminalReason {
  if (stopReason === 'EndTurn') return 'completed';
  if (stopReason === 'Aborted') return 'cancelled';
  return 'failed';
}

function withSessionId(event: LegacyWireEvent, sessionId: string): UIStreamEvent {
  return { ...event, _sessionId: sessionId } as UIStreamEvent;
}

function serializeArguments(args: unknown): string {
  try {
    return JSON.stringify(args) ?? '{}';
  } catch {
    return '{}';
  }
}

function serializeDetails(details: Record<string, unknown> | undefined): string | undefined {
  if (details === undefined) return undefined;
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return '[Unable to serialize error details]';
  }
}
