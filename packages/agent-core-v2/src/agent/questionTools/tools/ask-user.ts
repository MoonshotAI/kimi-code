/**
 * AskUserQuestionTool — structured user question tool.
 *
 * The LLM calls this tool when it needs structured input from the user
 * (multiple-choice, preference selection, disambiguation). The tool delegates
 * to the `questionTools` domain (backed by the `interaction` kernel), which owns
 * the actual UI interaction. With `background=true` the request is parked as a
 * background task and the answer arrives in a later turn.
 */

import { z } from 'zod';

import { CoreErrors } from '#/_base/errors/codes';
import { KimiError } from '#/_base/errors/errors';
import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import { errorMessage, isAbortError } from '#/agent/loop/errors';
import { IAgentTaskService } from '#/agent/task/task';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { TelemetryProperties } from '#/app/telemetry/telemetry';
import type {
  BuiltinTool,
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '#/agent/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { ISessionQuestionService } from '#/session/question/question';
import type {
  QuestionAnswers,
  QuestionAnswerMethod,
  QuestionResponse,
  QuestionResult,
} from '#/session/question/question';
import DESCRIPTION from './ask-user.md?raw';
import { QuestionTask } from './question-task';

// ── Input schema ─────────────────────────────────────────────────────

const QuestionOptionSchema = z.object({
  label: z
    .string()
    .min(1)
    .describe("Concise display text (1-5 words). If recommended, append '(Recommended)'."),
  description: z.string().default('').describe('Brief explanation of trade-offs or implications.'),
});

const QuestionItemSchema = z.object({
  question: z.string().min(1).describe("A specific, actionable question. End with '?'."),
  header: z
    .string()
    .default('')
    .describe("Short category tag (max 12 chars, e.g. 'Auth', 'Style')."),
  options: z
    .array(QuestionOptionSchema)
    .min(2)
    .max(4)
    .describe(
      "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically.",
    ),
  multi_select: z
    .boolean()
    .default(false)
    .describe('Whether the user can select multiple options.'),
});

export interface AskUserQuestionInput {
  background?: boolean;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multi_select: boolean;
  }>;
}

const QUESTION_UNIQUENESS_MESSAGE =
  'Question texts must be unique across questions, and option labels must be unique within each question.';

/**
 * Answers are keyed by question text with option labels as values, so both
 * must be unambiguous: question texts unique across the call, option labels
 * unique within their question. Runtime tool-arg validation is AJV against
 * the JSON Schema (where zod refinements are unrepresentable), so the
 * execution path re-runs this check itself.
 */
function questionUniquenessError(
  questions: AskUserQuestionInput['questions'],
): string | null {
  const texts = new Set<string>();
  for (const q of questions) {
    if (texts.has(q.question)) {
      return `Invalid questions: duplicate question text ${JSON.stringify(q.question)}. ${QUESTION_UNIQUENESS_MESSAGE} Rephrase the duplicates and call the tool again.`;
    }
    texts.add(q.question);
    const labels = new Set<string>();
    for (const option of q.options) {
      if (labels.has(option.label)) {
        return `Invalid questions: duplicate option label ${JSON.stringify(option.label)} in question ${JSON.stringify(q.question)}. ${QUESTION_UNIQUENESS_MESSAGE} Rephrase the duplicates and call the tool again.`;
      }
      labels.add(option.label);
    }
  }
  return null;
}

const AskUserQuestionInputBaseSchema = z.object({
  questions: z
    .array(QuestionItemSchema)
    .min(1)
    .max(4)
    .describe('The questions to ask the user (1-4 questions).'),
});

const AskUserQuestionInputSchemaWithBackground = AskUserQuestionInputBaseSchema.extend({
  background: z
    .boolean()
    .default(false)
    .describe(
      'Set true to ask in the background and return immediately with a background task_id; you are notified automatically when the user answers — do not poll with TaskOutput while the question is pending.',
    ),
}).refine((data) => questionUniquenessError(data.questions) === null, {
  message: QUESTION_UNIQUENESS_MESSAGE,
});

export const AskUserQuestionInputSchema: z.ZodType<AskUserQuestionInput> =
  AskUserQuestionInputBaseSchema.refine(
    (data) => questionUniquenessError(data.questions) === null,
    { message: QUESTION_UNIQUENESS_MESSAGE },
  );

const QUESTION_DISMISSED_MESSAGE = 'User dismissed the question without answering.';

const QUESTION_UNSUPPORTED_FAILURE_MESSAGE =
  'The connected client does not support interactive questions. Do NOT call this tool again. Ask the user directly in your text response instead.';

// ── Implementation ───────────────────────────────────────────────────

export class AskUserQuestionTool implements BuiltinTool<AskUserQuestionInput> {
  readonly name = 'AskUserQuestion' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    AskUserQuestionInputSchemaWithBackground,
  );

  constructor(
    @ISessionQuestionService private readonly question: ISessionQuestionService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

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
    { toolCallId, signal, turnId }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    // AJV (the runtime arg validator) cannot express the uniqueness refine,
    // so enforce it here before any UI interaction or task registration.
    const uniquenessError = questionUniquenessError(args.questions);
    if (uniquenessError !== null) {
      return { isError: true, output: uniquenessError };
    }

    if (args.background === true) {
      return this.executeInBackground(args, { toolCallId, turnId, signal });
    }
    return this.executeQuestion(args, { toolCallId, turnId, signal });
  }

  private async executeQuestion(
    args: AskUserQuestionInput,
    {
      toolCallId,
      signal,
      turnId,
    }: Pick<ExecutableToolContext, 'toolCallId' | 'signal' | 'turnId'>,
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
        { signal },
      );

      const normalized = normalizeQuestionResult(result);
      if (normalized === null || Object.keys(normalized.answers).length === 0) {
        this.telemetry.track('question_dismissed');
        return dismissedQuestionResult();
      }

      const properties: TelemetryProperties =
        normalized.method !== undefined
          ? { answered: Object.keys(normalized.answers).length, method: normalized.method }
          : { answered: Object.keys(normalized.answers).length };
      this.telemetry.track('question_answered', properties);
      return {
        isError: false,
        output: JSON.stringify({ answers: normalized.answers }),
      };
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;

      if (error instanceof KimiError && error.code === CoreErrors.codes.NOT_IMPLEMENTED) {
        return {
          isError: true,
          output: QUESTION_UNSUPPORTED_FAILURE_MESSAGE,
        };
      }

      return dismissedQuestionResult();
    }
  }

  private executeInBackground(
    args: AskUserQuestionInput,
    {
      toolCallId,
      signal,
      turnId,
    }: Pick<ExecutableToolContext, 'toolCallId' | 'signal' | 'turnId'>,
  ): ExecutableToolResult {
    if (signal.aborted) {
      signal.throwIfAborted();
    }

    const description = questionDescription(args.questions);
    let taskId: string;
    try {
      taskId = this.tasks.registerTask(
        new QuestionTask(
          (taskSignal) => this.executeQuestion(args, { toolCallId, turnId, signal: taskSignal }),
          description,
          {
            questionCount: args.questions.length,
            toolCallId,
          },
        ),
      );
    } catch (error) {
      return {
        isError: true,
        output: errorMessage(error),
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
      message: `Started ${taskId}`,
    };
  }
}

registerTool(AskUserQuestionTool);

function dismissedQuestionResult(): ExecutableToolResult {
  return {
    isError: false,
    output: JSON.stringify({
      answers: {},
      note: QUESTION_DISMISSED_MESSAGE,
    }),
  };
}

function questionDescription(questions: AskUserQuestionInput['questions']): string {
  const first = questions[0]?.question.trim();
  const label = first === undefined || first.length === 0 ? 'Ask user question' : first;
  if (questions.length <= 1) return label;
  return `${label} (+${String(questions.length - 1)} more)`;
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
