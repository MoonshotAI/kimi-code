import type { ToolDefinition } from '@moonshot-ai/agent-core';

import type { PlanData } from '../storage';

import DESCRIPTION from './enter-plan-mode.md?raw';

export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode';

export function createEnterPlanModeTool(plan: {
  readonly status: () => Promise<PlanData | null>;
  readonly enter: () => Promise<void>;
}): ToolDefinition {
  return {
    name: ENTER_PLAN_MODE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      if ((await plan.status()) !== null) {
        return errorResult('Plan mode is already active. Use ExitPlanMode when the plan is ready.');
      }
      try {
        await plan.enter();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to enter plan mode.';
        return errorResult(`Failed to enter plan mode: ${message}`);
      }
      const after = await plan.status();
      return textResult(enteredPlanModeMessage(after?.path ?? null));
    },
  };
}

export function enteredPlanModeMessage(planPath: string | null): string {
  if (planPath === null) {
    return [
      'Plan mode is now active. Your workflow:',
      '',
      '1. Use read-only tools (Read, Grep, Glob) to investigate the codebase. Use Bash only when needed.',
      '2. Design a concrete, step-by-step plan.',
      '3. Wait for the host to provide a plan file path before calling ExitPlanMode.',
      '',
      'Do NOT use Write or Edit while plan mode is active in this host; no plan file path is available.',
      'Use Bash only when needed; Bash follows the normal permission mode and rules.',
    ].join('\n');
  }

  return [
    'Plan mode is now active. Your workflow:',
    '',
    `Plan file: ${planPath}`,
    '',
    '1. Use read-only tools (Read, Grep, Glob) to investigate the codebase. Use Bash only when needed.',
    '2. Design a concrete, step-by-step plan.',
    '3. Write the plan to the plan file with Write or Edit.',
    '4. When the plan is ready, call ExitPlanMode for user approval.',
    '',
    'Do NOT edit files other than the plan file while plan mode is active.',
    'Use Bash only when needed; Bash follows the normal permission mode and rules.',
  ].join('\n');
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}
