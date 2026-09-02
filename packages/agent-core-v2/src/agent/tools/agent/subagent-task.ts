import type { TokenUsage } from '#/kosong/contract/usage';
import type { SubagentModelSource } from '#/session/subagent/configSection';

import { isAbortError } from '#/_base/utils/abort';
import { ErrorCodes, isError2 } from '#/errors';
import { REPEAT_BREAKER_STOP_REASON } from '#/agent/toolDedupe/toolDedupe';
import {
  type AgentTask,
  type AgentTaskInfoBase,
  type AgentTaskSink,
} from '#/agent/task/types';

const REPEAT_BREAKER_SETTLE_REASON =
  'stopped by the repeat breaker after issuing the same tool call repeatedly; its output is a handoff, not a finished result';

type SubagentCompletion = {
  readonly result: string;
  readonly usage?: TokenUsage;
  readonly stopReason?: string;
};

export type SubagentHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly parentToolCallId?: string;
  readonly model?: string;
  readonly modelSource?: SubagentModelSource;
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
  readonly stopCode?: string;
}

declare module '#/agent/task/types' {
  interface AgentTaskInfoByKind {
    readonly agent: SubagentTaskInfo;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stopCodeOf(error: unknown): string | undefined {
  if (!isError2(error)) return undefined;
  if (error.code === ErrorCodes.AGENT_NO_FINAL_MESSAGE) {
    const stopReason = error.details?.['stopReason'];
    if (typeof stopReason === 'string') return stopReason;
  }
  return error.code;
}

function completedSettleReason(stopReason: string | undefined): string | undefined {
  return stopReason === REPEAT_BREAKER_STOP_REASON ? REPEAT_BREAKER_SETTLE_REASON : undefined;
}

export function createSubagentExecutor(
  handle: SubagentHandle,
  abortController: AbortController,
): (signal: AbortSignal, output: (data: string) => void) => Promise<SubagentCompletion> {
  return async (signal, output) => {
    const requestAbort = (): void => {
      abortController.abort(signal.reason);
    };
    if (signal.aborted) {
      requestAbort();
    } else {
      signal.addEventListener('abort', requestAbort, { once: true });
    }

    try {
      const outcome = await handle.completion;
      output(outcome.result);
      return outcome;
    } catch (error: unknown) {
      if (signal.aborted && (isAbortError(error) || error === signal.reason)) {
        throw error;
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', requestAbort);
    }
  };
}

export class SubagentTask implements AgentTask {
  readonly kind = 'agent' as const;
  readonly idPrefix: string = 'agent';
  readonly agentId: string;
  readonly subagentType: string;
  readonly parentToolCallId?: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
  private stopCode: string | undefined;

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
      this.stopCode = outcome.stopReason;
      sink.appendOutput(outcome.result);
      await sink.settle({
        status: 'completed',
        stopReason: completedSettleReason(outcome.stopReason),
      });
    } catch (error: unknown) {
      if (sink.signal.aborted && (isAbortError(error) || error === sink.signal.reason)) {
        await sink.settle({ status: 'killed' });
        return;
      }
      this.stopCode = stopCodeOf(error);
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
      stopCode: this.stopCode,
    };
  }
}
