import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentPlanService } from '#/features/plan/plan';
import type { PlanData } from '#/features/plan/plan';

import DESCRIPTION from './exit-plan-mode.md?raw';
import {
  ExitPlanModeInputSchema,
  IExitPlanModeTool,
  type ExitPlanModeInput,
  type ExitPlanModePlanSource,
} from './exit-plan-mode';

type ResolvePlanResult =
  | { readonly ok: true; readonly plan: string; readonly path?: string | undefined }
  | { readonly ok: false; readonly error: ExecutableToolResult };

export class ExitPlanModeTool implements IExitPlanModeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ExitPlanMode' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ExitPlanModeInputSchema);

  constructor(@IAgentPlanService private readonly planMode: IAgentPlanService) {}

  async resolveExecution(args: ExitPlanModeInput): Promise<ToolExecution> {
    return {
      description: 'Presenting plan and exiting plan mode',
      display: await this.resolvePlanReviewDisplay(args),
      approvalRule: this.name,
      execute: () => this.execution(),
    };
  }

  private async resolvePlanReviewDisplay(
    args: ExitPlanModeInput,
  ): Promise<ToolInputDisplay | undefined> {
    let data: PlanData;
    try {
      data = await this.planMode.status();
    } catch {
      return undefined;
    }
    if (data === null || data.content.trim().length === 0) return undefined;
    try {
      await this.planMode.recordRevision();
    } catch {
    }
    const display: ToolInputDisplay = {
      kind: 'plan_review',
      plan: data.content,
      path: data.path ?? undefined,
    };
    if (args.options !== undefined && args.options.length >= 2) {
      display.options = args.options;
    }
    return display;
  }

  private async execution(): Promise<ExecutableToolResult> {
    const status = await this.planMode.status();
    if (status === null) {
      return {
        isError: true,
        output:
          'ExitPlanMode can only be called while plan mode is active. Only the user can turn plan mode on.',
      };
    }

    const resolvedPlan = await this.resolvePlan();
    if (!resolvedPlan.ok) return resolvedPlan.error;

    return {
      isError: true,
      output:
        'The plan could not be shown to the user for review, so plan mode is still active. Call ExitPlanMode again.',
    };
  }

  private async resolvePlan(): Promise<ResolvePlanResult> {
    let source: ExitPlanModePlanSource | null;
    try {
      const data = await this.planMode.status();
      source = data === null ? null : { plan: data.content, path: data.path ?? undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read plan file.';
      return {
        ok: false,
        error: { isError: true, output: `Failed to read plan file: ${message}` },
      };
    }

    if (source !== null && source.plan.trim().length > 0) {
      return {
        ok: true,
        plan: source.plan,
        path: source.path,
      };
    }

    const status = await this.planMode.status();
    const path = source?.path ?? status?.path ?? null;
    return {
      ok: false,
      error: {
        isError: true,
        output:
          path === null
            ? 'No plan file found. Write the plan to the current plan file first, then call ExitPlanMode.'
            : `No plan file found. Write your plan to ${path} first, then call ExitPlanMode.`,
      },
    };
  }
}
