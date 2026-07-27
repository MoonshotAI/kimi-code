/**
 * `questionTools` domain — `QuestionBackgroundTask`, the background-execution
 * handle for `AskUserQuestionTool` (`background: true`).
 *
 * Mirrors v1's `QuestionBackgroundTask`: runs the question request on a
 * detached task so the tool call can return immediately with a `task_id`,
 * while the user's answer (parked in `ISessionQuestionService`) settles the
 * task later. The task service fires the terminal notification on settle,
 * which delivers the answer to the agent in a later turn — see
 * `AgentTaskService` terminal notifications.
 */

import { isAbortError } from '#/_base/utils/abort';
import {
  type AgentTask,
  type AgentTaskInfoBase,
  type AgentTaskSink,
} from '#/agent/task/types';
import type { ExecutableToolResult } from '#/tool/toolContract';

export interface QuestionTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;
}

declare module '#/agent/task/types' {
  interface AgentTaskInfoByKind {
    readonly question: QuestionTaskInfo;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class QuestionBackgroundTask implements AgentTask {
  readonly kind = 'question' as const;
  readonly idPrefix: string = 'question';
  private readonly questionCount: number;
  private readonly toolCallId?: string;

  constructor(
    private readonly run: (signal: AbortSignal) => Promise<ExecutableToolResult>,
    readonly description: string,
    info: { questionCount: number; toolCallId?: string },
  ) {
    this.questionCount = info.questionCount;
    this.toolCallId = info.toolCallId;
  }

  async start(sink: AgentTaskSink): Promise<void> {
    try {
      const result = await this.run(sink.signal);
      const output =
        typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
      sink.appendOutput(output);
      await sink.settle({ status: 'completed' });
    } catch (error: unknown) {
      if (sink.signal.aborted && (isAbortError(error) || error === sink.signal.reason)) {
        await sink.settle({ status: 'killed' });
        return;
      }
      await sink.settle({ status: 'failed', stopReason: errorMessage(error) });
    }
  }

  toInfo(base: AgentTaskInfoBase): QuestionTaskInfo {
    return {
      ...base,
      kind: 'question',
      questionCount: this.questionCount,
      toolCallId: this.toolCallId,
    };
  }
}
