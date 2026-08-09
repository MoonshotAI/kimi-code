/**
 * `tools` domain — `IEnterPlanModeTool` implementation.
 *
 * Enters plan mode through the plan service (`plan`), reporting an error when
 * plan mode is already active, and tracks the `plan_enter_resolved`
 * `auto_approved` outcome (`telemetry`). The result message walks the model
 * through the plan-mode workflow, including the plan file path when the host
 * provides one. Bound at Agent scope.
 */

import type { ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentPlanService } from '#/agent/plan/plan';

import DESCRIPTION from './enter-plan-mode.md?raw';
import {
  EnterPlanModeInputSchema,
  IEnterPlanModeTool,
  type EnterPlanModeInput,
} from './enter-plan-mode';

export class EnterPlanModeTool implements IEnterPlanModeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'EnterPlanMode' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EnterPlanModeInputSchema);

  constructor(
    @IAgentPlanService private readonly planMode: IAgentPlanService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  resolveExecution(_args: EnterPlanModeInput): ToolExecution {
    return {
      description: 'Requesting to enter plan mode',
      approvalRule: this.name,
      execute: async () => {
        const before = await this.planMode.status();
        if (before !== null) {
          return {
            isError: true,
            output: 'Plan mode is already active. Use ExitPlanMode when the plan is ready.',
          };
        }

        try {
          await this.planMode.enter();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to enter plan mode.';
          return { isError: true, output: `Failed to enter plan mode: ${message}` };
        }

        this.telemetry.track2('plan_enter_resolved', {
          outcome: 'auto_approved',
        });
        const after = await this.planMode.status();
        return { output: enteredPlanModeMessage(after?.path ?? null) };
      },
    };
  }
}

registerAgentToolService(IEnterPlanModeTool, EnterPlanModeTool, { name: 'EnterPlanMode', domain: 'plan' });

function enteredPlanModeMessage(planPath: string | null): string {
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
