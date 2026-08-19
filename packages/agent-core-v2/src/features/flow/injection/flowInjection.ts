import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { IFlagService } from '#/app/flag/flag';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
  type ContextInjectionResult,
} from '#/agent/contextInjector/contextInjector';

import { FLOW_FLAG_ID, IAgentFlowService } from '../flow';

const FLOW_STAGE_INJECTION_VARIANT = 'flow_stage';

interface FlowStageInjectionDisclosure {
  readonly kind: 'flow_stage';
  readonly flowId: string;
  readonly stageIndex: number;
  readonly fingerprint?: string;
  readonly epoch?: number;
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
    @IFlagService private readonly flags: IFlagService,
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
    if (!this.flags.enabled(FLOW_FLAG_ID)) return undefined;
    this.flow.reconcilePendingActivation();
    const run = this.flow.run();
    if (!run.active) return undefined;
    const stage = this.flow.currentStage();
    if (stage === undefined || run.flowId === undefined) return undefined;
    const stageIndex = run.currentStageIndex ?? 0;
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
    const fingerprint = fingerprintOf(content);
    const epoch = this.flow.runEpoch();
    const last = ctx.lastDisclosure;
    if (
      last !== undefined &&
      last.flowId === run.flowId &&
      last.stageIndex === stageIndex &&
      last.fingerprint === fingerprint &&
      last.epoch === epoch
    ) {
      return undefined;
    }
    return {
      content,
      disclosure: { kind: 'flow_stage', flowId: run.flowId, stageIndex, fingerprint, epoch },
    };
  }
}

function escapeUntrustedText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function fingerprintOf(text: string): string {
  let hash = 5381;
  for (const ch of text) {
    // oxlint-disable-next-line unicorn/prefer-math-trunc -- `>>> 0` wraps to uint32; Math.trunc would let the hash grow past integer precision.
    hash = (Math.imul(hash, 33) + (ch.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash.toString(16);
}
