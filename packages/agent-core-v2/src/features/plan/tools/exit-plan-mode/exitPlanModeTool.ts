import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
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

type PlanReviewOption = NonNullable<ExitPlanModeInput['options']>[number];

interface PlanReviewApproval {
  readonly selectedLabel?: string;
}

function planReviewApproval(metadata: unknown): PlanReviewApproval | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const review = (metadata as { planReview?: unknown }).planReview;
  if (typeof review !== 'object' || review === null) return undefined;
  const selectedLabel = (review as { selectedLabel?: unknown }).selectedLabel;
  return { selectedLabel: typeof selectedLabel === 'string' ? selectedLabel : undefined };
}

function selectedOption(
  options: readonly PlanReviewOption[] | undefined,
  label: string | undefined,
): PlanReviewOption | undefined {
  if (options === undefined || label === undefined) return undefined;
  return options.find((option) => option.label === label);
}

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
      execute: (ctx) => this.execution(args, ctx),
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

  private async execution(
    args: ExitPlanModeInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
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

    const approval = planReviewApproval(ctx.metadata);
    if (approval === undefined) {
      return {
        isError: true,
        output:
          'The plan could not be shown to the user for review, so plan mode is still active. Call ExitPlanMode again.',
      };
    }

    const failed = this.exitPlanMode();
    if (failed !== undefined) return failed;

    const selected = selectedOption(args.options, approval.selectedLabel);
    const optionPrefix =
      selected === undefined
        ? ''
        : `Selected approach: ${selected.label}\nExecute ONLY the selected approach. Do not execute any unselected alternatives.\n\n`;
    const savedTo =
      resolvedPlan.path !== undefined ? `Plan saved to: ${resolvedPlan.path}\n\n` : '';
    return {
      isError: false,
      output: `Exited plan mode. ${optionPrefix}Plan mode deactivated. All tools are now available.\n${savedTo}## Approved Plan:\n${resolvedPlan.plan}`,
    };
  }

  private exitPlanMode(): ExecutableToolResult | undefined {
    try {
      this.planMode.exit();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to exit plan mode.';
      return {
        isError: true,
        output: `Failed to exit plan mode: ${message}`,
      };
    }
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
