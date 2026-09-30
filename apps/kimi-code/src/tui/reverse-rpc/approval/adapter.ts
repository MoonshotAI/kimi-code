import type { ApprovalResponse } from '@moonshot-ai/harness-core';

import type { ApprovalPanelResponse } from '#/tui/components/dialogs/approval-panel';
import type { ApprovalPanelChoice, ApprovalPanelData, DisplayBlock } from '#/tui/reverse-rpc/types';

export interface PermissionApprovalPayload {
  readonly id: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: {
    readonly kind: 'generic';
    readonly summary: string;
    readonly detail: unknown;
  };
  readonly toolInput?: unknown;
}

export interface PlanReviewPayload {
  readonly plan: string;
  readonly path: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
}

export interface GoalStartPayload {
  readonly kind: 'goal_start';
  readonly objective?: string;
  readonly completionCriterion?: string;
}

export function isPermissionApprovalPayload(payload: unknown): payload is PermissionApprovalPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { toolName?: unknown }).toolName === 'string' &&
    typeof (payload as { toolCallId?: unknown }).toolCallId === 'string'
  );
}

export function isPlanReviewPayload(payload: unknown): payload is PlanReviewPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { plan?: unknown }).plan === 'string' &&
    typeof (payload as { path?: unknown }).path === 'string'
  );
}

export function isGoalStartPayload(payload: unknown): payload is GoalStartPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { kind?: unknown }).kind === 'goal_start'
  );
}

const DEFAULT_APPROVAL_CHOICES: ApprovalPanelChoice[] = [
  { label: 'Approve once', response: 'approved' },
  { label: 'Approve for this session', response: 'approved_for_session' },
  { label: 'Reject', response: 'rejected' },
  { label: 'Reject with feedback', response: 'rejected', requires_feedback: true },
];

const GOAL_START_CHOICES: ApprovalPanelChoice[] = [
  { label: 'Start goal', response: 'approved' },
  { label: 'Do not start', response: 'rejected' },
  { label: 'Reject with feedback', response: 'rejected', requires_feedback: true },
];

const PLAN_REJECT_CHOICES: ApprovalPanelChoice[] = [
  { label: 'Reject and Exit', response: 'rejected', selected_label: 'Reject and Exit' },
  { label: 'Revise', response: 'rejected', selected_label: 'Revise', requires_feedback: true },
];

export function adaptApprovalPayload(
  interactionId: string,
  payload: PermissionApprovalPayload | PlanReviewPayload | GoalStartPayload,
): ApprovalPanelData {
  if (isGoalStartPayload(payload)) {
    const lines = [`Start goal: ${payload.objective ?? ''}`];
    if (payload.completionCriterion !== undefined && payload.completionCriterion.length > 0) {
      lines.push(`Done when: ${payload.completionCriterion}`);
    }
    return {
      id: interactionId,
      tool_call_id: interactionId,
      tool_name: 'CreateGoal',
      action: 'Start a goal?',
      description: '',
      display: [{ type: 'brief', text: lines.join('\n') }],
      choices: GOAL_START_CHOICES.map((choice) => ({ ...choice })),
    };
  }
  if (isPlanReviewPayload(payload)) {
    return {
      id: interactionId,
      tool_call_id: interactionId,
      tool_name: 'ExitPlanMode',
      action: 'Approve plan',
      description: '',
      display:
        payload.plan.trim().length > 0
          ? [{ type: 'file_content', path: payload.path, content: payload.plan }]
          : [],
      choices: adaptPlanReviewChoices(payload),
    };
  }
  const resolved = resolveDisplay(payload.toolName, payload.display.detail);
  return {
    id: interactionId,
    tool_call_id: payload.toolCallId,
    tool_name: payload.toolName,
    action: payload.action,
    description: resolved.description,
    display: resolved.blocks,
    choices: DEFAULT_APPROVAL_CHOICES.map((choice) => ({ ...choice })),
  };
}

interface ResolvedDisplay {
  blocks: DisplayBlock[];
  description: string;
}

function resolveDisplay(toolName: string, detail: unknown): ResolvedDisplay {
  if (isRecord(detail)) {
    const extracted = extractFromArgs(toolName, detail);
    if (extracted !== null) return extracted;
  }
  return { blocks: [], description: '' };
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

const DANGER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive|--force)/i, label: 'recursive delete' },
  { pattern: /\bsudo\b/i, label: 'sudo' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i, label: 'pipe to shell' },
  { pattern: /\bdd\b[^|]*\bof=/i, label: 'dd write' },
  { pattern: /\bmkfs\b/i, label: 'mkfs' },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd)/i, label: 'write to raw device' },
  { pattern: /\bchmod\s+-R?\s*777\b/i, label: 'chmod 777' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}/i, label: 'fork bomb' },
];

function detectDanger(command: string): string | undefined {
  for (const { pattern, label } of DANGER_PATTERNS) {
    if (pattern.test(command)) return label;
  }
  return undefined;
}

function adaptPlanReviewChoices(payload: PlanReviewPayload): ApprovalPanelChoice[] {
  const optionChoices =
    payload.options !== undefined && payload.options.length >= 2
      ? payload.options.map((option) => ({
          label: option.label,
          response: 'approved' as const,
          selected_label: option.label,
        }))
      : [{ label: 'Approve', response: 'approved' as const, selected_label: 'Approve' }];
  return [...optionChoices, ...PLAN_REJECT_CHOICES].map((choice) => ({ ...choice }));
}
