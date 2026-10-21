import { isAbsolute } from 'node:path';

import type {
  AvailableCommand,
  PlanEntry,
  PlanEntryStatus,
  SessionConfigOption,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type { ToolResultEvent } from '@moonshot-ai/agent-core-v2/events';
import type {
  AssistantDeltaEvent,
  ThinkingDeltaEvent,
  TurnEndReason,
} from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import type {
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolProgressEvent,
} from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import type { ToolInputDisplay } from '@moonshot-ai/agent-core-v2/tool/toolInputDisplay';

import { displayBlockToAcpContent, toolResultToAcpContent } from './convert';
import type { AcpStopReason } from './types';

export function assistantDeltaToSessionUpdate(
  sessionId: string,
  event: AssistantDeltaEvent,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: event.delta },
    },
  };
}

export function turnEndReasonToStopReason(
  reason: TurnEndReason,
  error?: { readonly code: string },
): AcpStopReason {
  switch (reason) {
    case 'completed':
      return 'end_turn';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      if (error?.code === 'provider.filtered') return 'refusal';
      return 'end_turn';
    case 'blocked':
      return 'refusal';
  }
}

const AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'provider.auth_error',
  'auth.login_required',
  'auth.token_missing',
  'auth.token_unauthorized',
  'auth.provisioning_required',
  'auth.model_not_resolved',
]);

export function isAuthError(error?: { readonly code: string }): boolean {
  return error !== undefined && AUTH_ERROR_CODES.has(error.code);
}

export function acpToolCallId(turnId: number, toolCallId: string): string {
  return `${turnId}:${toolCallId}`;
}

export function inferToolKind(name: string): ToolKind {
  switch (name) {
    case 'Read':
    case 'Glob':
    case 'Grep':
      return 'read';
    case 'Write':
    case 'Edit':
      return 'edit';
    case 'Bash':
    case 'Terminal':
      return 'execute';
    case 'WebFetch':
    case 'WebSearch':
      return 'fetch';
    case 'Think':
      return 'think';
    default:
      return 'other';
  }
}

export function stringifyArgs(args: unknown): string {
  try {
    return JSON.stringify(args) ?? String(args);
  } catch {
    return String(args);
  }
}

const FILE_TOOL_NAMES: ReadonlySet<string> = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep']);

function argsPath(name: string, args: unknown): string | undefined {
  if (!FILE_TOOL_NAMES.has(name) || typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ['file_path', 'path']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export function toolCallLocations(
  name: string,
  args: unknown,
  display: ToolInputDisplay | undefined,
): ToolCallLocation[] | undefined {
  const displayPath =
    display !== undefined && (display.kind === 'diff' || display.kind === 'file_io')
      ? display.path
      : undefined;
  const path = [displayPath, argsPath(name, args)].find(
    (candidate): candidate is string => candidate !== undefined && isAbsolute(candidate),
  );
  if (path === undefined) return undefined;
  return [{ path }];
}

export function toolCallStartToSessionUpdate(
  sessionId: string,
  event: ToolCallStartedEvent,
): SessionNotification {
  const title = event.description ?? event.name;
  const content: ToolCallContent[] = [
    {
      type: 'content',
      content: { type: 'text', text: stringifyArgs(event.args) },
    },
  ];
  if (event.display) {
    const diff = displayBlockToAcpContent(event.display);
    if (diff !== null) {
      content.unshift(diff);
    }
  }
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: acpToolCallId(event.turnId, event.toolCallId),
      title,
      kind: inferToolKind(event.name),
      status: 'in_progress',
      rawInput: event.args,
      locations: toolCallLocations(event.name, event.args, event.display),
      content,
    },
  };
}

export function toolCallDeltaToSessionUpdate(
  sessionId: string,
  event: ToolCallDeltaEvent,
  accumulator: { args: string },
): SessionNotification {
  accumulator.args += event.argumentsPart ?? '';
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: acpToolCallId(event.turnId, event.toolCallId),
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

export function toolCallLazyCreateToSessionUpdate(
  sessionId: string,
  event: ToolCallDeltaEvent,
): SessionNotification {
  const name = event.name ?? 'tool';
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: acpToolCallId(event.turnId, event.toolCallId),
      title: name,
      kind: event.name ? inferToolKind(event.name) : 'other',
      status: 'pending',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: event.argumentsPart ?? '' },
        },
      ],
    },
  };
}

export function toolCallStartedUpgradeToSessionUpdate(
  sessionId: string,
  event: ToolCallStartedEvent,
): SessionNotification {
  const title = event.description ?? event.name;
  const content: ToolCallContent[] = [
    {
      type: 'content',
      content: { type: 'text', text: stringifyArgs(event.args) },
    },
  ];
  if (event.display) {
    const diff = displayBlockToAcpContent(event.display);
    if (diff !== null) {
      content.unshift(diff);
    }
  }
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: acpToolCallId(event.turnId, event.toolCallId),
      title,
      kind: inferToolKind(event.name),
      status: 'in_progress',
      rawInput: event.args,
      locations: toolCallLocations(event.name, event.args, event.display),
      content,
    },
  };
}

export function toolProgressToSessionUpdate(
  sessionId: string,
  event: ToolProgressEvent,
): SessionNotification | null {
  if (event.update.kind === 'status' && event.update.text) {
    return {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: acpToolCallId(event.turnId, event.toolCallId),
        title: event.update.text,
      },
    };
  }
  return null;
}

export function thinkingDeltaToSessionUpdate(
  sessionId: string,
  event: ThinkingDeltaEvent,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: event.delta },
    },
  };
}

export function toolResultToSessionUpdate(
  sessionId: string,
  event: ToolResultEvent,
  locations?: ToolCallLocation[],
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: acpToolCallId(event.turnId, event.toolCallId),
      status: event.isError ? 'failed' : 'completed',
      content: toolResultToAcpContent(event),
      rawOutput: event.output,
      locations,
    },
  };
}

export function todoListToSessionUpdate(
  sessionId: string,
  turnId: number,
  items: ReadonlyArray<{ title: string; status: string }>,
): SessionNotification | null {
  void turnId;
  if (items.length === 0) return null;
  const entries: PlanEntry[] = items.map((item) => ({
    content: item.title,
    priority: 'medium',
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

function mapTodoStatus(status: string): PlanEntryStatus {
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

export function planFromDisplayBlock(
  sessionId: string,
  turnId: number,
  display: ToolInputDisplay,
): SessionNotification | null {
  if (display.kind !== 'todo_list') return null;
  return todoListToSessionUpdate(sessionId, turnId, display.items);
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
