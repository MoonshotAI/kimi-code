import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { AgentHost } from '#/agent/host/agentHost';
import { AgentRuntimeSet } from '#/actor/agentRuntimeSet';
import type { AgentRuntimeDefinitionRecord } from '#/actor/agentRuntime';
import { AgentFullCompaction } from '#/actor/fullCompaction/fullCompactionAgentRuntime';
import { AgentLoop } from '#/actor/loop/loop';
import { getLoopControl } from '#/actor/loop/internal/access';
import { AgentPrompt } from '#/actor/prompt/promptAgentRuntime';
import { AgentTask } from '#/actor/task/taskAgentRuntime';
import { abortError } from '#/_base/utils/abort';
import type { PromptRuntime } from '#/actor/prompt/prompt';

export interface AgentRuntimeHostCloseHandlers {
  onWillClose(): void;
  onDidClose(): void;
}

export class AgentRuntimeHost {
  private closing: Promise<void> | undefined;

  constructor(
    readonly agent: AgentContext,
    readonly host: AgentHost,
    readonly runtimeSet: AgentRuntimeSet,
    private readonly handlers: AgentRuntimeHostCloseHandlers,
  ) {}

  prompt(input: Parameters<PromptRuntime['enqueue']>[0]): ReturnType<PromptRuntime['enqueue']> {
    return this.runtimeSet.resolve(AgentPrompt).enqueue(input);
  }

  async cancel(reasonText?: string): Promise<void> {
    const loop = getLoopControl(this.agent);
    const compaction = this.runtimeSet.resolve(AgentFullCompaction);
    const reason = abortError(reasonText ?? 'Agent cancelled');
    const prompt = this.runtimeSet.resolve(AgentPrompt);
    for (const turnId of loop.status().pendingTurnIds) loop.cancel(turnId, reason);
    loop.cancel(undefined, reason);
    await Promise.all([loop.settled(), compaction.cancel(), prompt.drain(reason)]);
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closing = this.closeNow();
    return this.closing;
  }

  private async closeNow(): Promise<void> {
    this.handlers.onWillClose();
    await this.runtimeSet.resolve(AgentTask).stopAllOnExit('Session closed');
    await this.cancel('Agent removed');
    await this.runtimeSet.close();
    await this.host.dispose();
    this.handlers.onDidClose();
  }

  static create(
    agent: AgentContext,
    host: AgentHost,
    accessor: ServicesAccessor,
    records: readonly AgentRuntimeDefinitionRecord[],
    handlers: AgentRuntimeHostCloseHandlers,
  ): AgentRuntimeHost {
    const runtimeSet = new AgentRuntimeSet(agent, accessor, () => host.dispatcher);
    for (const record of records) runtimeSet.apply(record);
    return new AgentRuntimeHost(agent, host, runtimeSet, handlers);
  }
}

export function resolveAgentLoop(host: AgentRuntimeHost): void {
  host.runtimeSet.resolve(AgentLoop);
}
