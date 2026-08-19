import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import { IAgentFlowService, type FlowVerdictDecider } from '../../flow';

import DESCRIPTION from './jump.md?raw';
import { FlowJumpInputSchema, IFlowJumpTool, type FlowJumpInput } from './jump';

export class FlowJumpTool implements IFlowJumpTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'FlowJump' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(FlowJumpInputSchema);

  constructor(
    @IAgentFlowService private readonly flow: IAgentFlowService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
  ) {}

  resolveExecution(args: FlowJumpInput): ToolExecution {
    const display = this.jumpDisplay(args);
    const epochAtPrepare = this.flow.runEpoch();
    this.flow.stampPreparedEpoch(args);
    return {
      description: `Jumping the flow run to stage ${args.to}`,
      display,
      approvalRule: this.name,
      execute: (ctx) =>
        this.execution(args, this.flow.consumeGateApproval(ctx.toolCallId), epochAtPrepare),
    };
  }

  private jumpDisplay(rawArgs: FlowJumpInput): ToolInputDisplay | undefined {
    const parsed = FlowJumpInputSchema.safeParse(rawArgs);
    if (!parsed.success) return undefined;
    const args = parsed.data;
    if (this.flow.jumpPolicy() !== 'approval') return undefined;
    const run = this.flow.run();
    const stage = this.flow.currentStage();
    if (!run.active || stage === undefined || stage.id === args.to) return undefined;
    const stages = run.stages ?? [];
    const toIndex = stages.findIndex((candidate) => candidate.id === args.to);
    if (toIndex < 0) return undefined;
    return {
      kind: 'flow_jump_review',
      flow_id: run.flowId ?? 'unknown',
      task: run.task,
      from_stage_id: stage.id,
      to_stage_id: args.to,
      from_index: run.currentStageIndex ?? 0,
      to_index: toIndex,
      stage_total: stages.length,
      reason: args.reason,
    };
  }

  private async execution(
    rawArgs: FlowJumpInput,
    reviewedByUser: boolean,
    epochAtPrepare: number,
  ): Promise<ExecutableToolResult> {
    const parsed = FlowJumpInputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        isError: true,
        output: `Invalid FlowJump input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      };
    }
    const args = parsed.data;
    const run = this.flow.run();
    if (!run.active) {
      return { isError: true, output: 'No active flow run. Use FlowStart first.' };
    }
    if (this.flow.runEpoch() !== epochAtPrepare) {
      return {
        isError: true,
        output:
          'The flow run changed after this call was prepared (undo, abort, or a new run); the jump and any review it received are stale. Submit FlowJump again against the current run.',
      };
    }
    const policy = this.flow.jumpPolicy();
    if (policy === 'disabled') {
      return {
        isError: true,
        output:
          'This flow forbids stage jumps (`jumps: disabled`). Stages advance strictly in order; to restart, use FlowAbort and a fresh run.',
      };
    }
    const current = this.flow.currentStage();
    if (current === undefined) {
      return { isError: true, output: 'No active flow run. Use FlowStart first.' };
    }
    if (args.to === current.id) {
      return {
        isError: true,
        output: `The run is already at stage \`${current.id}\` — a jump must target a different stage.`,
      };
    }
    if (!(run.stages ?? []).some((stage) => stage.id === args.to)) {
      return {
        isError: true,
        output: `Unknown stage \`${args.to}\`. Stages: ${(run.stages ?? []).map((stage) => stage.id).join(', ')}.`,
      };
    }
    const needsReview = policy === 'approval' && this.modeService.mode !== 'auto';
    if (needsReview && !reviewedByUser) {
      return {
        isError: true,
        output:
          'This jump requires the user review, but no review happened when this call was prepared (a batched call, or the permission mode changed since). Submit FlowJump again as a standalone call.',
      };
    }
    const decidedBy: FlowVerdictDecider =
      policy === 'free' ? 'ai' : reviewedByUser ? 'human' : 'auto';
    const outcome = this.flow.jump({ to: args.to, reason: args.reason, decidedBy });
    if (!outcome.recorded || outcome.stage === undefined) {
      return { isError: true, output: 'The jump could not be recorded. Check the run status and retry.' };
    }
    const autoNote =
      decidedBy === 'auto'
        ? '\nNote: this jump was auto-approved without user review (permission mode is auto) — the user has NOT explicitly approved it.'
        : '';
    return {
      isError: false,
      output: `Jumped to stage \`${outcome.stage.id}\`.${autoNote}\n\n## Current stage: \`${outcome.stage.id}\`\n- Objective: ${outcome.stage.objective}\n- Completion: ${outcome.stage.completion}\n- Gate: ${outcome.stage.gate}${outcome.stage.notes === undefined ? '' : `\n- Notes: ${outcome.stage.notes}`}\n\nDispatch the stage to a worker with a self-contained brief, then verify its output against the completion criteria.`,
    };
  }
}
