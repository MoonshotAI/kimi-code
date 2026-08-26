import { fromCallback } from 'xstate';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { AgentRuntimeContext } from '#/agent/runtime/agentRuntime';
import { IInstantiationService } from '#/_base/di/instantiation';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnEnded } from '#/agent/loop/turnOps';

import { ToolExecutorPipeline } from '#/features/toolExecutor/internal/executor';
import {
  PERMISSION_GATE_PARTICIPANT,
  TOOL_DEDUPE_PARTICIPANT,
} from '#/features/toolExecutor/toolExecutor';
import { ToolExecutionPermissionPolicyChain } from '#/features/toolExecutor/internal/permissionPolicy';
import { ToolExecutionPermissionGatePolicy } from '#/features/toolExecutor/internal/permissionGate';
import { ToolDedupePolicy } from '#/features/toolExecutor/internal/toolDedupe';

export class ToolExecutorDomain {
  readonly pipeline: ToolExecutorPipeline;
  readonly dedupe: ToolDedupePolicy;

  constructor(readonly runtime: AgentRuntimeContext<unknown>) {
    this.pipeline = new ToolExecutorPipeline(runtime);
    const policyChain = new ToolExecutionPermissionPolicyChain(
      runtime.get(IInstantiationService),
    );
    const gate = new ToolExecutionPermissionGatePolicy(runtime, policyChain);
    this.dedupe = new ToolDedupePolicy(runtime, this.pipeline);
    this.pipeline.beforeExecuteBus.register(PERMISSION_GATE_PARTICIPANT, (event) =>
      gate.adjudicate(event),
    );
    this.pipeline.beforeExecuteBus.register(TOOL_DEDUPE_PARTICIPANT, this.dedupe.checkExecution);
    this.pipeline.registerDidExecuteHook(TOOL_DEDUPE_PARTICIPANT, this.dedupe.finalizeExecution);
  }
}

export const toolExecutorEffects = fromCallback(
  ({ input }: { input: ToolExecutorDomain }) => {
    const loop = input.runtime.get(IAgentLoopService);
    const disposables: IDisposable[] = [
      input.runtime.get(IEventBus).subscribe(TurnEnded, () => {
        input.dedupe.clearTurnRecords();
      }),
      loop.hooks.onWillBeginStep.register(TOOL_DEDUPE_PARTICIPANT, async (ctx, next) => {
        input.dedupe.beginStep(ctx.turnId, ctx.step);
        await next();
      }),
      loop.hooks.onDidFinishStep.register(TOOL_DEDUPE_PARTICIPANT, async (_ctx, next) => {
        input.dedupe.endStep();
        await next();
      }),
    ];
    return () => {
      for (let index = disposables.length - 1; index >= 0; index -= 1) {
        disposables[index]!.dispose();
      }
    };
  },
);
