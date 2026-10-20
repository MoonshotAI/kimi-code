import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core/tool/index';

import { formatPlanForOutput } from '../review';
import type { PlanData } from '../storage';

import DESCRIPTION from './exit-plan-mode.md?raw';

export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode';

export interface ExitPlanModeOption {
  readonly label: string;
  readonly description: string;
}

export type ExitPlanModeArgs =
  | { readonly ok: true; readonly options?: readonly ExitPlanModeOption[] }
  | { readonly ok: false; readonly error: string };

const RESERVED_OPTION_LABELS = new Set(
  ['Approve', 'Reject', 'Reject and Exit', 'Revise'].map(normalizeOptionLabel),
);

export function parseExitPlanModeArgs(raw: string | null): ExitPlanModeArgs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '{}');
  } catch {
    return { ok: false, error: 'Invalid arguments: expected a JSON object.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Invalid arguments: expected a JSON object.' };
  }
  const rawOptions = (parsed as Record<string, unknown>)['options'];
  if (rawOptions === undefined) return { ok: true, options: undefined };
  if (!Array.isArray(rawOptions) || rawOptions.length === 0 || rawOptions.length > 3) {
    return { ok: false, error: 'Invalid options: provide 1 to 3 options.' };
  }
  const options: ExitPlanModeOption[] = [];
  for (const value of rawOptions) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: 'Invalid options: each option must be an object with a label.' };
    }
    const label = (value as Record<string, unknown>)['label'];
    if (typeof label !== 'string' || label.length === 0 || label.length > 80) {
      return { ok: false, error: 'Invalid options: each option label must be 1-80 characters.' };
    }
    const description = (value as Record<string, unknown>)['description'];
    options.push({ label, description: typeof description === 'string' ? description : '' });
  }
  if (!hasUniqueOptionLabels(options)) {
    return { ok: false, error: 'Option labels must be unique.' };
  }
  if (!hasNoReservedOptionLabels(options)) {
    return { ok: false, error: 'Option labels must not use reserved approval labels.' };
  }
  return { ok: true, options };
}

export function createExitPlanModeTool(plan: {
  readonly status: () => Promise<PlanData | null>;
  readonly exit: (id?: string) => Promise<void>;
}): ToolDefinition {
  return {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        options: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          description:
            'When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use "Reject", "Revise", "Approve", or "Reject and Exit" as labels.',
          items: {
            type: 'object',
            properties: {
              label: {
                type: 'string',
                minLength: 1,
                maxLength: 80,
                description:
                  'Short name for this option (1-8 words). Append "(Recommended)" if you recommend this option.',
              },
              description: {
                type: 'string',
                description: 'Brief summary of this approach and its trade-offs.',
              },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async execute({ toolCall }) {
      const args = parseExitPlanModeArgs(toolCall.arguments);
      if (!args.ok) return errorResult(args.error);
      const status = await plan.status();
      if (status === null) {
        return errorResult(
          'ExitPlanMode can only be called while plan mode is active. Use EnterPlanMode (or /plan) first.',
        );
      }
      if (status.content.trim().length === 0) {
        return errorResult(
          `No plan file found. Write your plan to ${status.path} first, then call ExitPlanMode.`,
        );
      }
      await plan.exit();
      return textResult(`Exited plan mode. ${formatPlanForOutput(status.content, status.path)}`);
    },
  };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function hasUniqueOptionLabels(options: readonly ExitPlanModeOption[]): boolean {
  const labels = new Set<string>();
  for (const option of options) {
    const label = normalizeOptionLabel(option.label);
    if (labels.has(label)) return false;
    labels.add(label);
  }
  return true;
}

function hasNoReservedOptionLabels(options: readonly ExitPlanModeOption[]): boolean {
  return options.every((option) => !RESERVED_OPTION_LABELS.has(normalizeOptionLabel(option.label)));
}

function normalizeOptionLabel(label: string): string {
  return label.trim().toLowerCase();
}
