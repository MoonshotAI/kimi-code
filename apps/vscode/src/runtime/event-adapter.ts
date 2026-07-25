import type { Event } from '@moonshot-ai/kimi-code-sdk';

import type {
  DisplayBlock,
  LegacyWireEvent,
  StatusUpdate,
  TokenUsage,
  TurnBegin,
} from '../../shared/legacy-sdk';
import type { ErrorPhase, UIStreamEvent } from '../../shared/types';
import { toLegacyDisplay } from './tool-display';

const DEFAULT_MAIN_AGENT_ID = 'main';

export interface AdapterTokenUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface SubagentParent {
  readonly parentAgentId: string;
  readonly parentToolCallId: string;
}

export interface EventAdapterState {
  readonly subagentParents: Readonly<Record<string, SubagentParent>>;
  readonly turnUsageByAgent: Readonly<Record<string, AdapterTokenUsage>>;
  readonly toolDisplays: Readonly<Record<string, readonly DisplayBlock[]>>;
}

export interface AdaptedToolCallPartEvent {
  readonly type: 'ToolCallPart';
  readonly payload: {
    /** Lets the Webview update the right call when tool arguments interleave. */
    readonly tool_call_id: string;
    readonly arguments_part?: string | null;
  };
  readonly _sessionId?: string;
}

export type AdaptedUIStreamEvent = UIStreamEvent | AdaptedToolCallPartEvent;

type SdkTurnEndedEvent = Extract<Event, { type: 'turn.ended' }>;

export interface TurnTerminalMetadata {
  /** Stable within one adapter stream and suitable for terminal-event de-duplication. */
  readonly key: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: number;
  readonly reason: SdkTurnEndedEvent['reason'];
  readonly error?: NonNullable<SdkTurnEndedEvent['error']>;
}

export interface EventAdapterResult {
  readonly state: EventAdapterState;
  readonly event?: AdaptedUIStreamEvent;
  /** SessionRuntime owns conversion of this metadata to exactly one complete/error event. */
  readonly terminal?: TurnTerminalMetadata;
}

export interface AdaptSdkEventOptions {
  /** The SDK turn-start event intentionally does not repeat prompt content. */
  readonly pendingInput?: TurnBegin['user_input'];
  readonly mainAgentId?: string;
  readonly errorPhase?: ErrorPhase;
}

export function createEventAdapterState(): EventAdapterState {
  return {
    subagentParents: {},
    turnUsageByAgent: {},
    toolDisplays: {},
  };
}

/**
 * Purely projects one public Node SDK event into the released Webview protocol.
 * The returned state must be passed into the next call; the input state is never mutated.
 */
export function adaptSdkEvent(
  state: EventAdapterState,
  sdkEvent: Event,
  options: AdaptSdkEventOptions = {},
): EventAdapterResult {
  const mainAgentId = options.mainAgentId ?? DEFAULT_MAIN_AGENT_ID;

  if (sdkEvent.type === 'subagent.spawned') {
    const parentAgentId = sdkEvent.parentAgentId ?? sdkEvent.callerAgentId ?? sdkEvent.agentId;
    return {
      state: {
        ...state,
        subagentParents: {
          ...state.subagentParents,
          [sdkEvent.subagentId]: {
            parentAgentId,
            parentToolCallId: scopedToolCallId(
              parentAgentId,
              sdkEvent.parentToolCallId,
              mainAgentId,
            ),
          },
        },
      },
    };
  }

  if (sdkEvent.type === 'turn.started') {
    const nextState = resetTurnUsage(state, sdkEvent.agentId);
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

  if (sdkEvent.type === 'turn.ended') {
    if (sdkEvent.agentId !== mainAgentId) return { state };
    return {
      state,
      terminal: {
        key: `${sdkEvent.sessionId}:${sdkEvent.agentId}:${sdkEvent.turnId}`,
        sessionId: sdkEvent.sessionId,
        agentId: sdkEvent.agentId,
        turnId: sdkEvent.turnId,
        reason: sdkEvent.reason,
        error: sdkEvent.error,
      },
    };
  }

  if (sdkEvent.type === 'error') {
    if (sdkEvent.agentId !== mainAgentId) return { state };
    return {
      state,
      event: {
        type: 'error',
        code: sdkEvent.code,
        message: sdkEvent.message,
        detail: serializeDetails(sdkEvent.details),
        phase: options.errorPhase ?? 'runtime',
        _sessionId: sdkEvent.sessionId,
      },
    };
  }

  const mapped = mapLegacyWireEvent(state, sdkEvent, mainAgentId);
  if (mapped.event === undefined) return { state: mapped.state };

  const routed = routeSubagentEvent(
    mapped.state,
    sdkEvent.agentId,
    mapped.event,
    mainAgentId,
  );
  if (routed === undefined) return { state: mapped.state };

  return {
    state: mapped.state,
    event: withSessionId(routed, sdkEvent.sessionId),
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

function mapLegacyWireEvent(
  state: EventAdapterState,
  sdkEvent: Event,
  mainAgentId: string,
): MappedLegacyWireEvent {
  switch (sdkEvent.type) {
    case 'turn.step.started':
      return {
        state,
        event: { type: 'StepBegin', payload: { n: sdkEvent.step } },
      };
    case 'turn.step.retrying':
      return {
        state,
        event: {
          type: 'StatusUpdate',
          payload: {
            retrying: {
              next_attempt: sdkEvent.nextAttempt,
              max_attempts: sdkEvent.maxAttempts,
              delay_ms: sdkEvent.delayMs,
              message: sdkEvent.errorMessage,
            },
          },
        },
      };
    case 'turn.step.interrupted':
      return {
        state,
        event: { type: 'StepInterrupted', payload: {} },
      };
    case 'assistant.delta':
      return {
        state,
        event: { type: 'ContentPart', payload: { type: 'text', text: sdkEvent.delta } },
      };
    case 'hook.result':
      return {
        state,
        event: { type: 'ContentPart', payload: { type: 'text', text: sdkEvent.content } },
      };
    case 'thinking.delta':
      return {
        state,
        event: { type: 'ContentPart', payload: { type: 'think', think: sdkEvent.delta } },
      };
    case 'tool.call.started': {
      const toolCallId = scopedToolCallId(
        sdkEvent.agentId,
        sdkEvent.toolCallId,
        mainAgentId,
      );
      const display = sdkEvent.display === undefined ? undefined : toLegacyDisplay(sdkEvent.display);
      return {
        state: display === undefined
          ? state
          : {
              ...state,
              toolDisplays: { ...state.toolDisplays, [toolCallId]: display },
            },
        event: {
          type: 'ToolCall',
          payload: {
            type: 'function',
            id: toolCallId,
            function: {
              name: toLegacyToolName(sdkEvent.name),
              arguments: serializeArguments(sdkEvent.args),
            },
          },
        },
      };
    }
    case 'tool.call.delta': {
      const event: AdaptedToolCallPartEvent = {
        type: 'ToolCallPart',
        payload: {
          tool_call_id: scopedToolCallId(
            sdkEvent.agentId,
            sdkEvent.toolCallId,
            mainAgentId,
          ),
          arguments_part: sdkEvent.argumentsPart,
        },
      };
      return { state, event: event as LegacyWireEvent };
    }
    case 'tool.result': {
      const toolCallId = scopedToolCallId(
        sdkEvent.agentId,
        sdkEvent.toolCallId,
        mainAgentId,
      );
      const display = state.toolDisplays[toolCallId] ?? [];
      const toolDisplays = { ...state.toolDisplays };
      delete toolDisplays[toolCallId];
      const output = serializeToolOutput(sdkEvent.output);
      return {
        state: { ...state, toolDisplays },
        event: {
          type: 'ToolResult',
          payload: {
            tool_call_id: toolCallId,
            return_value: {
              is_error: sdkEvent.isError === true,
              output,
              message: '',
              display: [...display],
            },
          },
        },
      };
    }
    case 'agent.status.updated':
      return mapStatusUpdate(state, sdkEvent);
    case 'compaction.started':
      return {
        state,
        event: { type: 'CompactionBegin', payload: {} },
      };
    case 'compaction.blocked':
    case 'compaction.cancelled':
    case 'compaction.completed':
      return {
        state,
        event: { type: 'CompactionEnd', payload: {} },
      };
    default:
      return { state };
  }
}

function mapStatusUpdate(
  state: EventAdapterState,
  sdkEvent: Extract<Event, { type: 'agent.status.updated' }>,
): MappedLegacyWireEvent {
  const payload: StatusUpdate = {};
  if (sdkEvent.contextUsage !== undefined) payload.context_usage = sdkEvent.contextUsage;
  if (sdkEvent.planMode !== undefined) payload.plan_mode = sdkEvent.planMode;
  if (sdkEvent.model !== undefined) payload.model = sdkEvent.model;
  if (sdkEvent.thinkingEffort !== undefined) payload.thinking_effort = sdkEvent.thinkingEffort;

  const currentTurn = sdkEvent.usage?.currentTurn;
  if (currentTurn === undefined) {
    return Object.keys(payload).length === 0
      ? { state }
      : { state, event: { type: 'StatusUpdate', payload } };
  }

  const previous = state.turnUsageByAgent[sdkEvent.agentId];
  payload.token_usage = usageDelta(currentTurn, previous);
  return {
    state: {
      ...state,
      turnUsageByAgent: {
        ...state.turnUsageByAgent,
        [sdkEvent.agentId]: currentTurn,
      },
    },
    event: { type: 'StatusUpdate', payload },
  };
}

function usageDelta(current: AdapterTokenUsage, previous: AdapterTokenUsage | undefined): TokenUsage {
  return {
    input_other: delta(current.inputOther, previous?.inputOther),
    output: delta(current.output, previous?.output),
    input_cache_read: delta(current.inputCacheRead, previous?.inputCacheRead),
    input_cache_creation: delta(
      current.inputCacheCreation,
      previous?.inputCacheCreation,
    ),
  };
}

function delta(current: number, previous: number | undefined): number {
  if (previous === undefined || current < previous) return current;
  return current - previous;
}

function resetTurnUsage(state: EventAdapterState, agentId: string): EventAdapterState {
  if (state.turnUsageByAgent[agentId] === undefined) return state;
  const nextUsage = { ...state.turnUsageByAgent };
  delete nextUsage[agentId];
  return { ...state, turnUsageByAgent: nextUsage };
}

function routeSubagentEvent(
  state: EventAdapterState,
  agentId: string,
  event: LegacyWireEvent,
  mainAgentId: string,
): LegacyWireEvent | undefined {
  if (agentId === mainAgentId) return event;

  let currentAgentId = agentId;
  let routed = event;
  const visited = new Set<string>();

  while (currentAgentId !== mainAgentId) {
    if (visited.has(currentAgentId)) return undefined;
    visited.add(currentAgentId);

    const parent = state.subagentParents[currentAgentId];
    if (parent === undefined) return undefined;
    routed = {
      type: 'SubagentEvent',
      payload: {
        parent_tool_call_id: parent.parentToolCallId,
        event: routed,
      },
    };
    currentAgentId = parent.parentAgentId;
  }

  return routed;
}

function scopedToolCallId(agentId: string, toolCallId: string, mainAgentId: string): string {
  return agentId === mainAgentId ? toolCallId : `${agentId}:${toolCallId}`;
}

function withSessionId(event: LegacyWireEvent, sessionId: string): AdaptedUIStreamEvent {
  return { ...event, _sessionId: sessionId } as AdaptedUIStreamEvent;
}

function serializeArguments(args: unknown): string {
  try {
    return JSON.stringify(args) ?? '{}';
  } catch {
    return '{}';
  }
}

function serializeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2) ?? '';
  } catch {
    return String(output);
  }
}

function serializeDetails(details: Record<string, unknown> | undefined): string | undefined {
  if (details === undefined) return undefined;
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return "[Unable to serialize error details]";
  }
}
