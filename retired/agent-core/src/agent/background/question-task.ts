import { errorMessage, isAbortError } from '../../loop/errors';
import type { ExecutableToolOutput, ExecutableToolResult } from '../../loop/types';
import type {
  BackgroundTask,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
} from './task';

export interface QuestionBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;
}

export interface QuestionBackgroundTaskOptions {
  readonly questionCount: number;
  readonly toolCallId?: string;
}

export class QuestionBackgroundTask implements BackgroundTask {
  readonly kind = 'question' as const;
  readonly idPrefix = 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;

  constructor(
    private readonly run: (signal: AbortSignal) => Promise<ExecutableToolResult>,
    readonly description: string,
    options: QuestionBackgroundTaskOptions,
  ) {
    this.questionCount = options.questionCount;
    this.toolCallId = options.toolCallId;
  }

  async start(sink: BackgroundTaskSink): Promise<void> {
    try {
      const result = await this.run(sink.signal);
      const output = serializeToolOutput(result.output);
      if (output.length > 0) sink.appendOutput(output);
      await sink.settle({
        status: result.isError === true ? 'failed' : 'completed',
        stopReason: result.isError === true ? errorStopReason(result) : undefined,
      });
    } catch (error: unknown) {
      if (sink.signal.aborted && isAbortError(error)) {
        await sink.settle({ status: 'killed' });
        return;
      }
      await sink.settle({ status: 'failed', stopReason: errorMessage(error) });
    }
  }

  toInfo(base: BackgroundTaskInfoBase): QuestionBackgroundTaskInfo {
    return {
      ...base,
      kind: 'question',
      questionCount: this.questionCount,
      toolCallId: this.toolCallId,
    };
  }
}

function serializeToolOutput(output: ExecutableToolOutput): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

function errorStopReason(result: ExecutableToolResult): string | undefined {
  if (result.message !== undefined && result.message.length > 0) return result.message;
  if (typeof result.output !== 'string') return undefined;
  const trimmed = result.output.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
