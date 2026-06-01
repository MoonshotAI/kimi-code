import { sleep } from '@antfu/utils';

import { isAbortError } from '../../loop/errors';
import {
  type BackgroundTask,
  type BackgroundTaskInfoBase,
  type BackgroundTaskSink,
} from './task';

export interface AgentBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'agent';
  /** Subagent identifier accepted by Agent(resume=...). */
  readonly agentId?: string;
  /** Subagent profile name. */
  readonly subagentType?: string;
}

export interface AgentBackgroundTaskOptions {
  readonly timeoutMs?: number;
  readonly abort?: () => void;
  readonly agentId?: string;
  readonly subagentType?: string;
}

export class AgentBackgroundTask implements BackgroundTask {
  readonly kind = 'agent' as const;
  readonly idPrefix: string = 'agent';
  readonly timeoutMs?: number;
  readonly agentId?: string;
  readonly subagentType?: string;
  private readonly abort?: () => void;

  constructor(
    private readonly completion: Promise<{ result: string }>,
    readonly description: string,
    options: AgentBackgroundTaskOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs;
    this.abort = options.abort;
    this.agentId = options.agentId;
    this.subagentType = options.subagentType;
  }

  async start(sink: BackgroundTaskSink): Promise<void> {
    const requestAbort = (): void => {
      this.abort?.();
    };
    if (sink.signal.aborted) {
      requestAbort();
    } else {
      sink.signal.addEventListener('abort', requestAbort, { once: true });
    }

    const deadlineTimeout: unique symbol = Symbol('background-agent-deadline');
    const raceInputs: Array<Promise<{ result: string } | typeof deadlineTimeout>> = [
      this.completion,
    ];
    const timeoutMs = this.timeoutMs;

    if (timeoutMs !== undefined && timeoutMs > 0) {
      raceInputs.push(sleep(timeoutMs).then(() => deadlineTimeout));
    }

    try {
      const outcome = await Promise.race(raceInputs);
      if (outcome === deadlineTimeout) {
        this.abort?.();
        await sink.settle({ status: 'timed_out' });
        return;
      }
      sink.appendOutput(outcome.result);
      await sink.settle({ status: 'completed' });
    } catch (error: unknown) {
      if (sink.signal.aborted && isAbortError(error)) {
        await sink.settle({ status: 'killed' });
        return;
      }
      if (error instanceof Error && error.name === 'RunCancelled') {
        await sink.settle({ status: 'killed' });
        return;
      }
      await sink.settle({ status: 'failed' });
    } finally {
      sink.signal.removeEventListener('abort', requestAbort);
    }
  }

  toInfo(base: BackgroundTaskInfoBase): AgentBackgroundTaskInfo {
    return {
      ...base,
      kind: 'agent',
      agentId: this.agentId,
      subagentType: this.subagentType,
    };
  }
}
