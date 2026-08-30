import type { TokenUsage } from '#/kosong/contract/usage';

import { isAbortError } from '#/_base/utils/abort';
import {
  type TaskExecution,
  type AgentTaskInfoBase,
  type AgentTaskSink,
} from '#/actor/task/types';

type SubagentCompletion = {
  readonly result: string;
  readonly usage?: TokenUsage;
};

export type SubagentHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly parentToolCallId?: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly completion: Promise<SubagentCompletion>;
};

export interface SubagentTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'agent';
  readonly agentId?: string;
  readonly subagentType?: string;
  readonly parentToolCallId?: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
}

declare module '#/actor/task/types' {
  interface AgentTaskInfoByKind {
    readonly agent: SubagentTaskInfo;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SubagentTask implements TaskExecution {
  readonly kind = 'agent' as const;
  readonly idPrefix: string = 'agent';
  readonly agentId: string;
  readonly subagentType: string;
  readonly parentToolCallId?: string;
  readonly model?: string;
  readonly thinkingEffort?: string;

  constructor(
    private readonly handle: SubagentHandle,
    readonly description: string,
    private readonly abortController: AbortController,
  ) {
    this.agentId = handle.agentId;
    this.subagentType = handle.profileName;
    this.parentToolCallId = handle.parentToolCallId;
    this.model = handle.model;
    this.thinkingEffort = handle.thinkingEffort;
  }

  async start(sink: AgentTaskSink): Promise<void> {
    const requestAbort = (): void => {
      this.abortController.abort(sink.signal.reason);
    };
    if (sink.signal.aborted) {
      requestAbort();
    } else {
      sink.signal.addEventListener('abort', requestAbort, { once: true });
    }

    try {
      const outcome = await this.handle.completion;
      sink.appendOutput(outcome.result);
      await sink.settle({ status: 'completed' });
    } catch (error: unknown) {
      if (sink.signal.aborted && (isAbortError(error) || error === sink.signal.reason)) {
        await sink.settle({ status: 'killed' });
        return;
      }
      await sink.settle({ status: 'failed', stopReason: errorMessage(error) });
    } finally {
      sink.signal.removeEventListener('abort', requestAbort);
    }
  }

  toInfo(base: AgentTaskInfoBase): SubagentTaskInfo {
    return {
      ...base,
      kind: 'agent',
      agentId: this.agentId,
      subagentType: this.subagentType,
      parentToolCallId: this.parentToolCallId,
      model: this.model,
      thinkingEffort: this.thinkingEffort,
    };
  }
}
