import type { ApprovalRequest, ApprovalResponse, ToolInputDisplay } from '@moonshot-ai/kimi-code-sdk';

import { i18n } from '#/tui/i18n';
import type { ApprovalPanelResponse } from '#/tui/components/dialogs/approval-panel';
import type { ApprovalPanelChoice, ApprovalPanelData, DisplayBlock } from '#/tui/reverse-rpc/types';

// Choice labels are resolved at adapt time so a panel built while the active
// locale is `zh-CN` shows Chinese controls. `selected_label` stays a stable
// English identifier — it is reported upstream and must not shift with the UI
// language.
function defaultApprovalChoices(): ApprovalPanelChoice[] {
  return [
    { label: i18n.t('reverseRpc.approval.choice.approveOnce'), response: 'approved' },
    {
      label: i18n.t('reverseRpc.approval.choice.approveSession'),
      response: 'approved_for_session',
    },
    { label: i18n.t('reverseRpc.approval.choice.reject'), response: 'rejected' },
    {
      label: i18n.t('reverseRpc.approval.choice.rejectWithFeedback'),
      response: 'rejected',
      requires_feedback: true,
    },
  ];
}

function planRejectChoices(): ApprovalPanelChoice[] {
  return [
    { label: i18n.t('reverseRpc.approval.choice.reject'), response: 'rejected', selected_label: 'Reject' },
    {
      label: i18n.t('reverseRpc.approval.choice.revise'),
      response: 'rejected',
      selected_label: 'Revise',
      requires_feedback: true,
    },
  ];
}

export function adaptApprovalRequest(event: ApprovalRequest): ApprovalPanelData {
  const resolved = resolveDisplay(event.toolName, event.display, event.action);
  return {
    id: event.toolCallId,
    tool_call_id: event.toolCallId,
    tool_name: event.toolName,
    action: event.action,
    description: resolved.description,
    display: resolved.blocks,
    choices: adaptChoices(event.toolName, event.display),
  };
}

interface ResolvedDisplay {
  blocks: DisplayBlock[];
  description: string;
}

function resolveDisplay(
  toolName: string,
  display: ToolInputDisplay,
  action: string,
): ResolvedDisplay {
  if (display.kind === 'generic' && isRecord(display.detail)) {
    const extracted = extractFromArgs(toolName, display.detail);
    if (extracted !== null) return extracted;
  }
  return {
    blocks: adaptDisplay(display),
    description: describeApproval(display, action),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(detail: Record<string, unknown>, key: string): string | undefined {
  const value = detail[key];
  return typeof value === 'string' ? value : undefined;
}

function extractFromArgs(
  toolName: string,
  detail: Record<string, unknown>,
): ResolvedDisplay | null {
  const command = stringField(detail, 'command');
  if (command !== undefined) {
    const cwd = stringField(detail, 'cwd');
    const toolDescription = stringField(detail, 'description');
    const danger = detectDanger(command);
    const language = stringField(detail, 'language') ?? 'bash';
    return {
      blocks: [
        {
          type: 'shell',
          language,
          command,
          cwd,
          description: toolDescription,
          danger,
        },
      ],
      description: toolDescription ?? '',
    };
  }

  const oldString = stringField(detail, 'old_string');
  const newString = stringField(detail, 'new_string');
  if (oldString !== undefined && newString !== undefined) {
    const path = stringField(detail, 'file_path') ?? stringField(detail, 'path') ?? '';
    // Diff block carries its own `+N -M path` header — no separate
    // file_op title row needed.
    return {
      blocks: [{ type: 'diff', path, old_text: oldString, new_text: newString }],
      description: '',
    };
  }

  const filePath = stringField(detail, 'file_path') ?? stringField(detail, 'path');
  const content = stringField(detail, 'content');
  if (filePath !== undefined && content !== undefined) {
    // Write is a brand-new file: render the content as a syntax-
    // highlighted code block, not a diff full of `+` markers.
    return {
      blocks: [{ type: 'file_content', path: filePath, content }],
      description: '',
    };
  }

  const url = stringField(detail, 'url');
  if (url !== undefined) {
    const method = stringField(detail, 'method');
    return {
      blocks: [{ type: 'url_fetch', url, method }],
      description: '',
    };
  }

  const query = stringField(detail, 'query');
  if (query !== undefined) {
    return {
      blocks: [{ type: 'search', query }],
      description: '',
    };
  }

  const pattern = stringField(detail, 'pattern');
  if (pattern !== undefined) {
    const scope = stringField(detail, 'path');
    return {
      blocks: [{ type: 'search', query: pattern, scope }],
      description: '',
    };
  }

  if (filePath !== undefined) {
    const operation = inferFileOp(toolName);
    return {
      blocks: [{ type: 'file_op', operation, path: filePath }],
      description: '',
    };
  }

  return null;
}

function inferFileOp(toolName: string): 'read' | 'write' | 'edit' | 'glob' | 'grep' {
  const lower = toolName.toLowerCase();
  if (lower.includes('glob')) return 'glob';
  if (lower.includes('grep')) return 'grep';
  if (lower.includes('edit')) return 'edit';
  if (lower.includes('write')) return 'write';
  return 'read';
}

export function adaptPanelResponse(response: ApprovalPanelResponse): ApprovalResponse {
  if (response.response === 'approved_for_session') {
    return {
      decision: 'approved',
      scope: 'session',
      feedback: response.feedback,
      selectedLabel: response.selected_label,
    };
  }
  return {
    decision:
      response.response === 'approved'
        ? 'approved'
        : response.response === 'rejected'
          ? 'rejected'
          : 'cancelled',
    feedback: response.feedback,
    selectedLabel: response.selected_label,
  };
}

function describeApproval(display: ToolInputDisplay, action: string): string {
  switch (display.kind) {
    case 'plan_review':
      return '';
    case 'generic':
      if (typeof display.detail === 'string' && display.detail.length > 0) {
        return display.detail;
      }
      return display.summary ?? action;
    case 'command':
      return display.description ?? display.command ?? action;
    case 'diff':
      return `edit ${display.path ?? ''}`.trim();
    case 'file_io':
      return `${display.operation ?? 'file'} ${display.path ?? ''}`.trim();
    case 'task_stop':
      return `stop task: ${display.task_description ?? display.task_id ?? ''}`.trim();
    case 'agent_call':
      return `spawn ${display.agent_name ?? 'agent'}`;
    case 'skill_call':
      return `invoke skill ${display.skill_name ?? ''}`.trim();
    case 'url_fetch':
      return `fetch ${display.url ?? ''}`.trim();
    case 'search':
      return `search: ${display.query ?? ''}`.trim();
    case 'todo_list':
      return `update todo list (${String(display.items?.length ?? 0)} items)`;
    case 'background_task':
      return `${display.status ?? 'background'} task ${display.task_id ?? ''}: ${
        display.description ?? ''
      }`.trim();
    default:
      return action;
  }
}

// `key` indexes `reverseRpc.approval.danger.*` so the label localizes with the
// active UI language; the pattern detection itself is language-agnostic.
const DANGER_PATTERNS: Array<{ pattern: RegExp; key: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive|--force)/i, key: 'recursiveDelete' },
  { pattern: /\bsudo\b/i, key: 'sudo' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i, key: 'pipeToShell' },
  { pattern: /\bdd\b[^|]*\bof=/i, key: 'ddWrite' },
  { pattern: /\bmkfs\b/i, key: 'mkfs' },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd)/i, key: 'rawDevice' },
  { pattern: /\bchmod\s+-R?\s*777\b/i, key: 'chmod777' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}/i, key: 'forkBomb' },
];

function detectDanger(command: string): string | undefined {
  for (const { pattern, key } of DANGER_PATTERNS) {
    if (pattern.test(command)) return i18n.t(`reverseRpc.approval.danger.${key}`);
  }
  return undefined;
}

function adaptDisplay(display: ToolInputDisplay): DisplayBlock[] {
  switch (display.kind) {
    case 'command': {
      const command = display.command ?? '';
      const danger = detectDanger(command);
      return [
        {
          type: 'shell',
          language: display.language ?? 'bash',
          command,
          cwd: display.cwd,
          description: display.description,
          danger,
        },
      ];
    }
    case 'diff':
      return [
        {
          type: 'diff',
          path: display.path ?? '',
          old_text: display.before ?? '',
          new_text: display.after ?? '',
        },
      ];
    case 'file_io': {
      const path = display.path ?? '';
      // Write attaches the full file content — render it as a syntax-
      // highlighted code block so the approval panel can preview (and
      // ctrl+e expand) what is about to land on disk.
      if (display.operation === 'write' && typeof display.content === 'string') {
        return [{ type: 'file_content', path, content: display.content }];
      }
      // Edit attaches the old_string/new_string hunk as before/after — render
      // it as a diff block so ctrl+e expansion works on the change.
      if (
        display.operation === 'edit' &&
        typeof display.before === 'string' &&
        typeof display.after === 'string'
      ) {
        return [{ type: 'diff', path, old_text: display.before, new_text: display.after }];
      }
      return [
        {
          type: 'file_op',
          operation: display.operation,
          path,
          detail: display.detail,
        },
      ];
    }
    case 'url_fetch':
      return [
        {
          type: 'url_fetch',
          url: display.url ?? '',
          method: display.method,
        },
      ];
    case 'search':
      return [
        {
          type: 'search',
          query: display.query ?? '',
          scope: display.scope,
        },
      ];
    case 'agent_call':
      return [
        {
          type: 'invocation',
          kind: 'agent',
          name: display.agent_name ?? '',
          description: display.prompt,
        },
      ];
    case 'skill_call':
      return [
        {
          type: 'invocation',
          kind: 'skill',
          name: display.skill_name ?? '',
          description: display.args,
        },
      ];
    case 'task_stop':
      return [
        {
          type: 'brief',
          text: `Stop task ${display.task_id ?? ''}: ${display.task_description ?? ''}`,
        },
      ];
    case 'plan_review':
      return [];
    case 'generic':
      return [];
    case 'todo_list':
      return [];
    case 'background_task':
      return [];
    default:
      return [];
  }
}

function adaptChoices(toolName: string, display: ToolInputDisplay): ApprovalPanelChoice[] {
  if (toolName === 'ExitPlanMode' || display.kind === 'plan_review') {
    return adaptPlanReviewChoices(display);
  }

  return defaultApprovalChoices();
}

function adaptPlanReviewChoices(display: ToolInputDisplay): ApprovalPanelChoice[] {
  const optionChoices =
    display.kind === 'plan_review' && display.options !== undefined && display.options.length >= 2
      ? display.options.map((option) => ({
          label: option.label,
          response: 'approved' as const,
          selected_label: option.label,
        }))
      : [
          {
            label: i18n.t('reverseRpc.approval.choice.approve'),
            response: 'approved' as const,
            selected_label: 'Approve',
          },
        ];
  return [...optionChoices, ...planRejectChoices()];
}
