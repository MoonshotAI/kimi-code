import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
  type ContextInjectionResult,
} from '#/agent/contextInjector/contextInjector';

import { IAgentFlowService } from '../flow';

const FLOW_STAGE_INJECTION_VARIANT = 'flow_stage';

interface FlowStageInjectionDisclosure {
  readonly kind: 'flow_stage';
  readonly flowId: string;
  readonly stageIndex: number;
}

export interface IFlowInjection {
  readonly _serviceBrand: undefined;
}
export const IFlowInjection: ServiceIdentifier<IFlowInjection> =
  createDecorator<IFlowInjection>('flowInjection');

export class FlowInjection extends Disposable implements IFlowInjection {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentFlowService private readonly flow: IAgentFlowService,
  ) {
    super();
    this._register(
      injector.register<FlowStageInjectionDisclosure>(FLOW_STAGE_INJECTION_VARIANT, (ctx) =>
        this.reminder(ctx),
      ),
    );
  }

  private reminder(
    ctx: ContextInjectionContext<FlowStageInjectionDisclosure>,
  ): ContextInjectionResult<FlowStageInjectionDisclosure> | undefined {
    const run = this.flow.run();
    if (!run.active) return undefined;
    const stage = this.flow.currentStage();
    if (stage === undefined || run.flowId === undefined) return undefined;
    const stageIndex = run.currentStageIndex ?? 0;
    const last = ctx.lastDisclosure;
    if (last !== undefined && last.flowId === run.flowId && last.stageIndex === stageIndex) {
      return undefined;
    }
    const total = run.stages?.length ?? 0;
    const notes =
      stage.notes === undefined ? '' : `\nStage notes: ${escapeUntrustedText(stage.notes)}`;
    const task =
      run.task === undefined || run.task.length === 0
        ? ''
        : `\nTask: ${escapeUntrustedText(run.task)}`;
    const content = [
      `Flow run \`${run.flowId}\` is at stage \`${stage.id}\` (${stageIndex + 1}/${total}, gate: ${stage.gate}).${task}`,
      `Objective: ${escapeUntrustedText(stage.objective)}`,
      `Completion: ${escapeUntrustedText(stage.completion)}${notes}`,
      'You are the supervisor of this run: dispatch the stage work to a worker subagent instead of doing it yourself; when the worker reports, verify every completion criterion against objective evidence (artifacts, diffs, execution output — not the worker summary), then submit your verdict with FlowAdvance.',
    ].join('\n');
    return {
      content,
      disclosure: { kind: 'flow_stage', flowId: run.flowId, stageIndex },
    };
  }
}

function escapeUntrustedText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
