import type {
  PermissionOption,
  RequestPermissionOutcome,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type {
  ApprovalRequest,
  ApprovalResponse,
  ToolInputDisplay,
  ToolUpdate,
} from '@moonshot-ai/kimi-code-sdk';

const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Allow for session', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];

export function defaultPermissionOptions(): readonly PermissionOption[] {
  return PERMISSION_OPTIONS;
}

export function toAcpToolCallId(turnId: number | undefined, toolCallId: string): string {
  return turnId === undefined ? toolCallId : `${turnId}:${toolCallId}`;
}

export function approvalRequestToToolCallUpdate(request: ApprovalRequest): ToolCallUpdate {
  return {
    toolCallId: toAcpToolCallId(request.turnId, request.toolCallId),
    title: request.action,
    kind: displayToToolKind(request.display, request.toolName),
    locations: displayToLocations(request.display),
    content: displayToContent(request.display),
  };
}

export function approvalResponseFromOutcome(
  outcome: RequestPermissionOutcome,
  options: readonly PermissionOption[] = PERMISSION_OPTIONS,
): ApprovalResponse {
  if (outcome.outcome === 'cancelled') {
    return { decision: 'cancelled' };
  }

  const option = options.find((item) => item.optionId === outcome.optionId);
  switch (option?.kind) {
    case 'allow_once':
      return { decision: 'approved', selectedLabel: option.name };
    case 'allow_always':
      return { decision: 'approved', scope: 'session', selectedLabel: option.name };
    case 'reject_once':
    case 'reject_always':
      return { decision: 'rejected', selectedLabel: option.name };
    case undefined:
      return { decision: 'cancelled', feedback: `Unknown permission option: ${outcome.optionId}` };
    default:
      return { decision: 'cancelled' };
  }
}

export function displayToToolKind(
  display: ToolInputDisplay | undefined,
  fallbackName?: string,
): ToolKind {
  if (display === undefined) return nameToToolKind(fallbackName);
  switch (display.kind) {
    case 'command':
    case 'background_task':
    case 'task_stop':
      return 'execute';
    case 'file_io':
      return fileOperationToToolKind(display.operation);
    case 'diff':
      return 'edit';
    case 'search':
      return 'search';
    case 'url_fetch':
      return 'fetch';
    case 'todo_list':
    case 'plan_review':
      return 'think';
    case 'agent_call':
    case 'skill_call':
    case 'generic':
      return nameToToolKind(fallbackName);
    default: {
      const exhaustive: never = display;
      void exhaustive;
      return 'other';
    }
  }
}

export function displayToLocations(
  display: ToolInputDisplay | undefined,
): ToolCallLocation[] | undefined {
  if (display === undefined) return undefined;
  switch (display.kind) {
    case 'file_io':
    case 'diff':
      return [{ path: display.path }];
    case 'plan_review':
      return display.path === undefined ? undefined : [{ path: display.path }];
    case 'agent_call':
    case 'background_task':
    case 'command':
    case 'generic':
    case 'search':
    case 'skill_call':
    case 'task_stop':
    case 'todo_list':
    case 'url_fetch':
      return undefined;
    default: {
      const exhaustive: never = display;
      void exhaustive;
      return undefined;
    }
  }
}

export function displayToContent(
  display: ToolInputDisplay | undefined,
): ToolCallContent[] | undefined {
  if (display === undefined) return undefined;
  switch (display.kind) {
    case 'command':
      return [textToolContent(formatCommandDisplay(display))];
    case 'file_io':
      return fileDisplayToContent(display);
    case 'diff':
      return [
        {
          type: 'diff',
          path: display.path,
          oldText: display.before,
          newText: display.after,
        },
      ];
    case 'search':
      return [textToolContent(`Search: ${display.query}${display.scope ? `\nScope: ${display.scope}` : ''}`)];
    case 'url_fetch':
      return [textToolContent(`${display.method ?? 'GET'} ${display.url}`)];
    case 'agent_call':
      return [textToolContent(`${display.agent_name}${display.background === true ? ' (background)' : ''}\n${display.prompt}`)];
    case 'skill_call':
      return [textToolContent(`${display.skill_name}${display.args ? `\n${display.args}` : ''}`)];
    case 'todo_list':
      return [
        textToolContent(
          display.items.map((item) => `${item.status}: ${item.title}`).join('\n'),
        ),
      ];
    case 'background_task':
      return [textToolContent(`${display.status}: ${display.description}`)];
    case 'task_stop':
      return [textToolContent(`Stop task ${display.task_id}: ${display.task_description}`)];
    case 'plan_review':
      return [textToolContent(display.plan)];
    case 'generic':
      return [
        textToolContent(
          display.detail === undefined
            ? display.summary
            : `${display.summary}\n${stringifyForDisplay(display.detail)}`,
        ),
      ];
    default: {
      const exhaustive: never = display;
      void exhaustive;
      return undefined;
    }
  }
}

export function textToolContent(text: string): ToolCallContent {
  return {
    type: 'content',
    content: {
      type: 'text',
      text,
    },
  };
}

export function toolUpdateToText(update: ToolUpdate): string {
  switch (update.kind) {
    case 'stdout':
    case 'stderr':
    case 'progress':
    case 'status':
      return update.text ?? (update.percent === undefined ? update.kind : `${update.kind}: ${update.percent}%`);
    case 'custom':
      return update.text ?? stringifyForDisplay(update.customData ?? update.customKind ?? 'custom update');
    default:
      return stringifyForDisplay(update);
  }
}

export function stringifyForDisplay(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function fileOperationToToolKind(operation: Extract<ToolInputDisplay, { kind: 'file_io' }>['operation']): ToolKind {
  switch (operation) {
    case 'read':
      return 'read';
    case 'write':
    case 'edit':
      return 'edit';
    case 'glob':
    case 'grep':
      return 'search';
    default: {
      const exhaustive: never = operation;
      void exhaustive;
      return 'other';
    }
  }
}

function nameToToolKind(name: string | undefined): ToolKind {
  const lower = name?.toLowerCase() ?? '';
  if (lower.includes('read')) return 'read';
  if (lower.includes('write') || lower.includes('edit') || lower.includes('patch')) return 'edit';
  if (lower.includes('delete') || lower.includes('remove')) return 'delete';
  if (lower.includes('search') || lower.includes('grep') || lower.includes('glob')) return 'search';
  if (lower.includes('fetch') || lower.includes('url')) return 'fetch';
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('exec')) return 'execute';
  return 'other';
}

function formatCommandDisplay(display: Extract<ToolInputDisplay, { kind: 'command' }>): string {
  const lines = [display.cwd === undefined ? undefined : `cwd: ${display.cwd}`, display.command].filter(
    (line): line is string => line !== undefined && line.length > 0,
  );
  return lines.join('\n');
}

function fileDisplayToContent(
  display: Extract<ToolInputDisplay, { kind: 'file_io' }>,
): ToolCallContent[] | undefined {
  if (display.before !== undefined || display.after !== undefined) {
    return [
      {
        type: 'diff',
        path: display.path,
        oldText: display.before ?? '',
        newText: display.after ?? display.content ?? '',
      },
    ];
  }
  if (display.content !== undefined) {
    return [textToolContent(display.content)];
  }
  if (display.detail !== undefined) {
    return [textToolContent(display.detail)];
  }
  return undefined;
}
