import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { DeepReadonly } from '#/state/state';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import {
  IAgentFlowService,
  type FlowStageDefinition,
  type FlowVerdictDecider,
} from '../../flow';

import DESCRIPTION from './advance.md?raw';
import { FlowAdvanceInputSchema, IFlowAdvanceTool, type FlowAdvanceInput } from './advance';

export class FlowAdvanceTool implements IFlowAdvanceTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'FlowAdvance' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(FlowAdvanceInputSchema);

  constructor(
    @IAgentFlowService private readonly flow: IAgentFlowService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
  ) {}

  resolveExecution(args: FlowAdvanceInput): ToolExecution {
    const display = this.gateDisplay(args);
    return {
      description: `Submitting ${args.verdict} verdict for stage ${args.stage}`,
      display,
      approvalRule: this.name,
      execute: () => this.execution(args, display !== undefined),
    };
  }

  private gateDisplay(args: FlowAdvanceInput): ToolInputDisplay | undefined {
    if (args.verdict !== 'pass') return undefined;
    const run = this.flow.run();
    const stage = this.flow.currentStage();
    if (!run.active || stage === undefined || stage.id !== args.stage) return undefined;
    if (stage.gate === 'ai') return undefined;
    const stageIndex = run.currentStageIndex ?? 0;
    return {
      kind: 'flow_gate_review',
      flow_id: run.flowId ?? 'unknown',
      task: run.task,
      stage_id: stage.id,
      stage_index: stageIndex,
      stage_total: run.stages?.length ?? 0,
      gate: stage.gate,
      objective: stage.objective,
      completion: stage.completion,
      next_stage_id: run.stages?.[stageIndex + 1]?.id,
      criteria: args.criteria,
      note: args.note,
    };
  }

  private async execution(
    args: FlowAdvanceInput,
    reviewed: boolean,
  ): Promise<ExecutableToolResult> {
    const run = this.flow.run();
    if (!run.active) {
      return { isError: true, output: 'No active flow run. Use FlowStart first.' };
    }
    const stage = this.flow.currentStage();
    if (stage === undefined || stage.id !== args.stage) {
      return {
        isError: true,
        output: `Stage mismatch: the current stage is \`${stage?.id ?? 'none'}\`, but the verdict targets \`${args.stage}\`. Stages advance strictly in order.`,
      };
    }

    if (args.verdict === 'reject') {
      this.flow.advance({
        stage: args.stage,
        result: 'reject',
        decidedBy: 'ai',
        criteria: args.criteria,
        feedback: args.note,
      });
      return {
        isError: false,
        output: `Rejection recorded for stage \`${args.stage}\`. Rework the stage against the unmet criteria (typically by resuming the same worker with this feedback), then submit FlowAdvance again.`,
      };
    }

    const unmet = args.criteria.filter((criterion) => !criterion.met);
    if (unmet.length > 0) {
      return {
        isError: true,
        output: `A pass verdict requires every criterion to be met; unmet: ${unmet.map((criterion) => criterion.criterion).join('; ')}. Finish the work first, or submit verdict: "reject" to record the failed acceptance.`,
      };
    }

    const autoMode = this.modeService.mode === 'auto';
    const needsReview = stage.gate !== 'ai' && !autoMode;
    if (needsReview && !reviewed) {
      return {
        isError: true,
        output: `Stage \`${args.stage}\` requires the user gate review, but the run state changed between preparing and executing this call (batched tool calls), so the review was skipped. Submit FlowAdvance again as a standalone call.`,
      };
    }
    const decidedBy: FlowVerdictDecider = stage.gate === 'ai' ? 'ai' : autoMode ? 'auto' : 'human';
    const outcome = this.flow.advance({
      stage: args.stage,
      result: 'pass',
      decidedBy,
      criteria: args.criteria,
      feedback: args.note,
    });
    if (!outcome.recorded) {
      return { isError: true, output: 'The verdict could not be recorded. Check the run status and retry.' };
    }

    const autoNote =
      decidedBy === 'auto'
        ? '\nNote: this gate was auto-approved without user review (permission mode is auto) — the user has NOT explicitly approved it.'
        : '';
    if (outcome.runFinished) {
      return {
        isError: false,
        output: `Stage \`${args.stage}\` passed. All stages are complete — the flow run is finished.${autoNote}`,
      };
    }
    return {
      isError: false,
      output: `Stage \`${args.stage}\` passed.${autoNote}\n\n${renderNextStage(outcome.nextStage)}`,
    };
  }
}

function renderNextStage(stage: DeepReadonly<FlowStageDefinition> | undefined): string {
  if (stage === undefined) return 'The run has no further stage.';
  const notes = stage.notes === undefined ? '' : `\n- Notes: ${stage.notes}`;
  return [
    `## Next stage: \`${stage.id}\``,
    `- Objective: ${stage.objective}`,
    `- Completion: ${stage.completion}`,
    `- Gate: ${stage.gate}${notes}`,
    '',
    'Dispatch the stage to a worker with a self-contained brief (objective, boundaries, relevant context, expected deliverable), then verify its output against the completion criteria.',
  ].join('\n');
}
