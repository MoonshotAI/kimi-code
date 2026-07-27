/**
 * `tools` domain (L7) — `IExitPlanModeTool` implementation.
 *
 * Reads the plan file tracked by the plan service (`plan`) and flips plan
 * mode off. Every submission — the moment the final content is read for the
 * `plan_review` display — records a plan revision through
 * `planMode.recordRevision()` (blob snapshot + `plan.revision` wire record),
 * so a Revise → resubmit archives each reviewed version.
 *
 * `execute` runs only when no interactive review ask intercepted the call. In
 * auto permission mode (`permissionMode`) the auto-mode-approve policy lets
 * every call through before any ask can fire, so the result is worded as
 * auto-approved (not user-reviewed), matching the `auto_approved` telemetry
 * outcome (`telemetry`). In manual / yolo modes the review-ask policy owns
 * the user-facing result; the only way `execute` still runs there is a
 * configured or session allow/ask rule — an explicit user decision that keeps
 * the user-approved output and the `approved` outcome. Bound at Agent scope.
 */

import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentPlanService } from '#/agent/plan/plan';
import type { PlanData } from '#/agent/plan/plan';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';

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

  constructor(
    @IAgentPlanService private readonly planMode: IAgentPlanService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  async resolveExecution(args: ExitPlanModeInput): Promise<ToolExecution> {
    return {
      description: 'Presenting plan and exiting plan mode',
      display: await this.resolvePlanReviewDisplay(args),
      approvalRule: this.name,
      execute: () => this.execution(args),
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
    // Every submission finalises a revision of the exact content under
    // review (a Revise → resubmit records the next version). Best-effort:
    // a recording failure must not block the review round-trip.
    try {
      await this.planMode.recordRevision();
    } catch {
      // Revision recording failed; the review continues with the live file.
    }
    const display: ToolInputDisplay = {
      kind: 'plan_review',
      plan: data.content,
      path: data.path,
    };
    if (args.options !== undefined && args.options.length >= 2) {
      display.options = args.options;
    }
    return display;
  }

  private async execution(args: ExitPlanModeInput): Promise<ExecutableToolResult> {
    const status = await this.planMode.status();
    if (status === null) {
      return {
        isError: true,
        output:
          'ExitPlanMode can only be called while plan mode is active. Use EnterPlanMode (or /plan) first.',
      };
    }

    const resolvedPlan = await this.resolvePlan();
    if (!resolvedPlan.ok) return resolvedPlan.error;

    this.telemetry.track2('plan_submitted', {
      has_options: args.options !== undefined && args.options.length >= 2,
    });

    const failed = this.exitPlanMode();
    if (failed !== undefined) return failed;

    if (this.permissionMode.mode === 'auto') {
      this.telemetry.track2('plan_resolved', {
        outcome: 'auto_approved',
      });
      return {
        isError: false,
        output: `Exited plan mode. ${formatAutoApprovedPlanForOutput(resolvedPlan.plan, resolvedPlan.path)}`,
      };
    }

    this.telemetry.track2('plan_resolved', {
      outcome: 'approved',
    });
    return {
      isError: false,
      output: `Exited plan mode. ${formatPlanForOutput(resolvedPlan.plan, resolvedPlan.path)}`,
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
      source = data === null ? null : { plan: data.content, path: data.path };
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

registerAgentToolService(IExitPlanModeTool, ExitPlanModeTool, { name: 'ExitPlanMode', domain: 'plan' });

function formatAutoApprovedPlanForOutput(plan: string, path: string | undefined): string {
  const savedTo = path !== undefined ? `Plan saved to: ${path}\n\n` : '';
  return `Plan mode deactivated. All tools are now available.\nNote: this plan was auto-approved without user review — the user has NOT explicitly approved it. Follow the user's original instructions on whether to proceed with execution; if they asked you to stop, wait, or only summarize after planning, do not start executing.\n${savedTo}## Plan (auto-approved, not user-reviewed):\n${plan}`;
}

function formatPlanForOutput(plan: string, path: string | undefined): string {
  const savedTo = path !== undefined ? `Plan saved to: ${path}\n\n` : '';
  return `Plan mode deactivated. All tools are now available.\n${savedTo}## Approved Plan:\n${plan}`;
}
