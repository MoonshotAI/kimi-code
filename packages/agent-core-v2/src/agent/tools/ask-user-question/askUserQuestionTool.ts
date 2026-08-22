import { z } from 'zod';

import { CoreErrors } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';
import { toInputJsonSchema } from '#/tool/input-schema';
import { isAbortError } from '#/_base/utils/abort';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { QuestionAnsweredEvent, QuestionDismissedEvent } from '#/app/telemetry/events';
import type {
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { ISessionQuestionService } from '#/session/question/question';
import type {
  QuestionAnswers,
  QuestionAnswerMethod,
  QuestionResponse,
  QuestionResult,
} from '#/session/question/question';
import {
  AskUserQuestionInputSchemaWithBackground,
  IAskUserQuestionTool,
  questionUniquenessError,
  type AskUserQuestionInput,
} from './ask-user-question';
import DESCRIPTION from './ask-user.md?raw';
import { QuestionBackgroundTask } from './question-background-task';

const QUESTION_DISMISSED_MESSAGE = 'User dismissed the question without answering.';

const QUESTION_UNSUPPORTED_FAILURE_MESSAGE =
  'The connected client does not support interactive questions. Do NOT call this tool again. Ask the user directly in your text response instead.';

export class AskUserQuestionTool implements IAskUserQuestionTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'AskUserQuestion' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  constructor(
    @ISessionQuestionService private readonly question: ISessionQuestionService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {
    this.description = `${DESCRIPTION}- Set background=true when you can keep working without the answer. This starts a background question task and returns a task_id immediately. The answer arrives automatically in a later turn — you do not need to poll, sleep, or check on it. Continue with other work; never fabricate or predict the answer.`;
    this.parameters = toInputJsonSchema(this.inputSchema());
  }

  resolveExecution(args: AskUserQuestionInput): ToolExecution {
    const isBackground = args.background === true;
    return {
      description: isBackground
        ? `Starting background question: ${questionDescription(args.questions)}`
        : 'Asking user questions',
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: AskUserQuestionInput,
    { toolCallId, signal, turnId, trace }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const uniquenessError = questionUniquenessError(args.questions);
    if (uniquenessError !== null) {
      return { isError: true, output: uniquenessError };
    }

    if (args.background === true) {
      return this.executeInBackground(args, { toolCallId, turnId, signal, trace });
    }

    return this.executeQuestion(args, { toolCallId, turnId, signal, trace });
  }

  private inputSchema(): z.ZodType<AskUserQuestionInput> {
    return AskUserQuestionInputSchemaWithBackground;
  }

  private executeInBackground(
    args: AskUserQuestionInput,
    {
      toolCallId,
      signal,
      turnId,
      trace,
    }: Pick<ExecutableToolContext, 'toolCallId' | 'signal' | 'turnId' | 'trace'>,
  ): ExecutableToolResult {
    if (signal.aborted) {
      signal.throwIfAborted();
    }

    const description = questionDescription(args.questions);
    let taskId: string;
    try {
      taskId = this.tasks.registerTask(
        new QuestionBackgroundTask(
          (taskSignal) => this.executeQuestion(args, { toolCallId, turnId, signal: taskSignal, trace }),
          description,
          { questionCount: args.questions.length, toolCallId },
        ),
        { detached: true },
      );
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    const status = this.tasks.getTask(taskId)?.status ?? 'running';
    return {
      isError: false,
      output:
        `task_id: ${taskId}\n` +
        `description: ${description}\n` +
        `status: ${status}\n` +
        `automatic_notification: true\n` +
        'next_step: Continue your current work; the answer will arrive automatically when the user responds.\n' +
        'next_step: Use TaskOutput with this task_id for a non-blocking status/answer snapshot.\n' +
        'next_step: Use TaskStop only if the question should be cancelled.\n' +
        'human_shell_hint: The pending question is also visible in /tasks.',
    };
  }

  private async executeQuestion(
    args: AskUserQuestionInput,
    {
      toolCallId,
      signal,
      turnId,
      trace,
    }: Pick<ExecutableToolContext, 'toolCallId' | 'signal' | 'turnId' | 'trace'>,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.question.request(
        {
          turnId,
          toolCallId,
          questions: args.questions.map((q) => ({
            question: q.question,
            header: q.header,
            options: q.options.map((o) => ({
              label: o.label,
              description: o.description,
            })),
            multiSelect: q.multi_select,
          })),
        },
        { signal, agentId: this.scopeContext.agentId },
      );

      const normalized = normalizeQuestionResult(result);
      if (normalized === null || Object.keys(normalized.answers).length === 0) {
        const properties: QuestionDismissedEvent = {
          trace_id: trace?.traceId,
        };
        this.telemetry.track2('question_dismissed', properties);
        return dismissedQuestionResult();
      }

      const properties: QuestionAnsweredEvent = {
        answered: Object.keys(normalized.answers).length,
        trace_id: trace?.traceId,
      };
      if (normalized.method !== undefined) properties.method = normalized.method;
      this.telemetry.track2('question_answered', properties);
      return {
        isError: false,
        output: JSON.stringify({ answers: normalized.answers }),
      };
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;

      if (error instanceof Error2 && error.code === CoreErrors.codes.NOT_IMPLEMENTED) {
        return {
          isError: true,
          output: QUESTION_UNSUPPORTED_FAILURE_MESSAGE,
        };
      }

      return dismissedQuestionResult();
    }
  }
}

registerAgentToolService(IAskUserQuestionTool, AskUserQuestionTool, {
  name: 'AskUserQuestion',
  domain: 'questionTools',
});

function questionDescription(questions: AskUserQuestionInput['questions']): string {
  const first = questions[0]?.question.trim();
  const label = first === undefined || first.length === 0 ? 'Ask user question' : first;
  if (questions.length <= 1) return label;
  return `${label} (+${String(questions.length - 1)} more)`;
}

function dismissedQuestionResult(): ExecutableToolResult {
  return {
    isError: false,
    output: JSON.stringify({
      answers: {},
      note: QUESTION_DISMISSED_MESSAGE,
    }),
  };
}

function normalizeQuestionResult(
  result: QuestionResult,
): { readonly answers: QuestionAnswers; readonly method?: QuestionAnswerMethod | undefined } | null {
  if (result === null) return null;
  if (isQuestionResponse(result)) {
    return {
      answers: result.answers,
      method: result.method,
    };
  }
  return { answers: result };
}

function isQuestionResponse(result: Exclude<QuestionResult, null>): result is QuestionResponse {
  if (typeof result !== 'object' || result === null) return false;
  if (!Object.hasOwn(result, 'answers')) return false;
  const answers = (result as { readonly answers?: unknown }).answers;
  return typeof answers === 'object' && answers !== null && !Array.isArray(answers);
}
