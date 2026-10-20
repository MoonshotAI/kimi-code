import type {
  AvailableCommand,
  SessionConfigOption,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
} from '@agentclientprotocol/sdk';
import type { ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { ToolCallOutcome, TurnOutcome } from '@moonshot-ai/agent-core/loop/index';
import type { ToolUpdate } from '@moonshot-ai/agent-core/tool/index';

import {
  acpToolCallId,
  inferToolKind,
  parseToolCallArguments,
  stringifyArgs,
  toolCallLocations,
  toolOutcomeRawOutput,
  toolOutcomeToAcpContent,
} from './convert';
import type { AcpStopReason } from './types';

export function textChunkToSessionUpdate(sessionId: string, text: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
  };
}

export function thoughtChunkToSessionUpdate(sessionId: string, text: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text },
    },
  };
}

export function userMessageChunkToSessionUpdate(
  sessionId: string,
  text: string,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
    },
  };
}

export function toolCallLazyCreateToSessionUpdate(
  sessionId: string,
  turnId: number,
  toolCall: ToolCall,
  argumentsPart: string,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: acpToolCallId(turnId, toolCall.id),
      title: toolCall.name,
      kind: inferToolKind(toolCall.name),
      status: 'pending',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: argumentsPart },
        },
      ],
    },
  };
}

export function toolCallDeltaToSessionUpdate(
  sessionId: string,
  wireId: string,
  argumentsPart: string,
  accumulator: { args: string },
): SessionNotification {
  accumulator.args += argumentsPart;
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: wireId,
      status: 'in_progress',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: accumulator.args },
        },
      ],
    },
  };
}

function startedContent(args: unknown): ToolCallContent[] {
  return [
    {
      type: 'content',
      content: { type: 'text', text: stringifyArgs(args) },
    },
  ];
}

export function toolCallStartToSessionUpdate(
  sessionId: string,
  turnId: number,
  toolCall: ToolCall,
  diff?: ToolCallContent | null,
): SessionNotification {
  const args = parseToolCallArguments(toolCall.arguments);
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: acpToolCallId(turnId, toolCall.id),
      title: toolCall.name,
      kind: inferToolKind(toolCall.name),
      status: 'in_progress',
      rawInput: args,
      locations: toolCallLocations(toolCall.name, args),
      content: diff === null || diff === undefined ? startedContent(args) : [diff, ...startedContent(args)],
    },
  };
}

export function planUpdateNotification(
  sessionId: string,
  items: ReadonlyArray<{ title: string; status: string }>,
): SessionNotification | null {
  if (items.length === 0) return null;
  const entries = items.map((item) => ({
    content: item.title,
    priority: 'medium' as const,
    status: mapTodoStatus(item.status),
  }));
  return {
    sessionId,
    update: {
      sessionUpdate: 'plan',
      entries,
    },
  };
}

function mapTodoStatus(status: string): 'pending' | 'in_progress' | 'completed' {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'in_progress';
    case 'done':
    case 'completed':
      return 'completed';
    default:
      return 'pending';
  }
}

export function toolCallStartedUpgradeToSessionUpdate(
  sessionId: string,
  turnId: number,
  toolCall: ToolCall,
  diff?: ToolCallContent | null,
): SessionNotification {
  const args = parseToolCallArguments(toolCall.arguments);
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: acpToolCallId(turnId, toolCall.id),
      title: toolCall.name,
      kind: inferToolKind(toolCall.name),
      status: 'in_progress',
      rawInput: args,
      locations: toolCallLocations(toolCall.name, args),
      content: diff === null || diff === undefined ? startedContent(args) : [diff, ...startedContent(args)],
    },
  };
}

export function toolUpdateToSessionUpdate(
  sessionId: string,
  wireId: string,
  update: ToolUpdate,
): SessionNotification | null {
  if (update.key === 'status' && update.text.length > 0) {
    return {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: wireId,
        title: update.text,
      },
    };
  }
  if (update.key === 'terminal' && update.text.length > 0) {
    return {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: wireId,
        content: [{ type: 'terminal', terminalId: update.text }],
      },
    };
  }
  return null;
}

export function toolDoneToSessionUpdate(
  sessionId: string,
  wireId: string,
  outcome: ToolCallOutcome,
  locations?: ToolCallLocation[],
  terminalId?: string,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: wireId,
      status:
        outcome.type === 'succeeded' && outcome.entry.meta?.isError !== true ? 'completed' : 'failed',
      content:
        terminalId !== undefined
          ? [{ type: 'terminal', terminalId }]
          : toolOutcomeToAcpContent(outcome),
      rawOutput: terminalId !== undefined ? undefined : toolOutcomeRawOutput(outcome),
      locations,
    },
  };
}

interface LlmFailurePayload {
  readonly kind?: unknown;
  readonly message?: unknown;
  readonly finishReason?: unknown;
}

function llmFailurePayloadOf(outcome: TurnOutcome): LlmFailurePayload | undefined {
  if (outcome.type !== 'failed') return undefined;
  const error = outcome.error;
  if (typeof error !== 'object' || error === null) return undefined;
  return error as LlmFailurePayload;
}

export function authRequiredMessageOf(outcome: TurnOutcome): string | undefined {
  const error = llmFailurePayloadOf(outcome);
  if (error?.kind !== 'auth') return undefined;
  return typeof error.message === 'string' ? error.message : undefined;
}

export function turnOutcomeToStopReason(outcome: TurnOutcome): AcpStopReason {
  switch (outcome.type) {
    case 'done':
      return 'end_turn';
    case 'aborted':
      return 'cancelled';
    case 'blocked':
      return 'end_turn';
    case 'failed': {
      const error = llmFailurePayloadOf(outcome);
      if (error?.kind === 'empty_response' && error.finishReason === 'filtered') return 'refusal';
      return 'end_turn';
    }
  }
}

export function usageUpdateNotification(
  sessionId: string,
  used: number,
  size: number,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'usage_update',
      used,
      size,
    },
  };
}

export function sessionInfoUpdateNotification(
  sessionId: string,
  title: string | null,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'session_info_update',
      title,
    },
  };
}

export function currentModeUpdateNotification(
  sessionId: string,
  currentModeId: string,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'current_mode_update',
      currentModeId,
    },
  };
}

export function configOptionUpdateNotification(
  sessionId: string,
  configOptions: readonly SessionConfigOption[],
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'config_option_update',
      configOptions: [...configOptions],
    },
  };
}

export function availableCommandsUpdateNotification(
  sessionId: string,
  commands: ReadonlyArray<AvailableCommand> = [],
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands: commands.slice(),
    },
  };
}
