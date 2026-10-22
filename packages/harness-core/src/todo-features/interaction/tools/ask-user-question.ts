import { z } from 'zod';

import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core/tool/index';
import { zodSchema } from '@moonshot-ai/agent-core/tool/index';

import type {
  TelemetryEventDefinition,
  TelemetryProperties,
} from '#/todo-features/telemetry/index';

import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_SESSION_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  INTERACTION_TAG_TURN_ID,
  isInteractionCancellation,
  type InteractionTags,
  type Interactions,
} from '../interaction';

import DESCRIPTION from './ask-user-question.md?raw';

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

const AskUserQuestionInputBaseSchema = z.object({
  questions: z
    .array(QuestionItemSchema)
    .min(1)
    .max(4)
    .describe('The questions to ask the user (1-4 questions).'),
});

const AskUserQuestionInputSchema = AskUserQuestionInputBaseSchema.extend({
  background: z
    .boolean()
    .default(false)
    .describe(
      'Set true to ask in the background and return immediately with a background task_id; you are notified automatically when the user answers — do not poll with TaskOutput while the question is pending.',
    ),
});

export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>;

export type QuestionAnswerMethod = 'enter' | 'space' | 'number_key';

export type QuestionAnswers = Record<string, string | true>;

export interface QuestionResponse {
  readonly answers: QuestionAnswers;
  readonly method?: QuestionAnswerMethod;
}

export type QuestionResult = null | QuestionAnswers | QuestionResponse;

export interface AskUserQuestionToolDeps {
  readonly interactions: Interactions;
  readonly sessionId: string;
  readonly agentId: string;
  readonly track: (event: string, properties?: TelemetryProperties) => void;
}

export const questionTelemetryEvents = [
  { name: 'question_answered', properties: ['answered', 'method'] },
  { name: 'question_dismissed' },
] as const satisfies readonly TelemetryEventDefinition[];

const QUESTION_DISMISSED_MESSAGE = 'User dismissed the question without answering.';

const QUESTION_UNSUPPORTED_FAILURE_MESSAGE =
  'The connected client does not support interactive questions. Do NOT call this tool again. Ask the user directly in your text response instead.';

const BACKGROUND_DESCRIPTION =
  '- Set background=true when you can keep working without the answer. This starts a background question task and returns a task_id immediately. The answer arrives automatically in a later turn — you do not need to poll, sleep, or check on it. Continue with other work; never fabricate or predict the answer.';

const QUESTION_UNIQUENESS_MESSAGE =
  'Question texts must be unique across questions, and option labels must be unique within each question.';

export function questionUniquenessError(
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

const inputSchema = zodSchema(AskUserQuestionInputSchema);

export function createAskUserQuestionTool(deps: AskUserQuestionToolDeps): ToolDefinition {
  return {
    name: 'AskUserQuestion',
    description: `${DESCRIPTION}${BACKGROUND_DESCRIPTION}`,
    parameters: inputSchema.jsonSchema,
    async execute({ toolCall, signal, turnId, detach }): Promise<ToolResult> {
      signal.throwIfAborted();
      let raw: unknown;
      try {
        raw = JSON.parse(toolCall.arguments ?? '{}');
      } catch {
        return errorResult('invalid arguments: malformed JSON');
      }
      const args = inputSchema.parse(raw);
      if (args === undefined) return errorResult('invalid arguments');
      const uniquenessError = questionUniquenessError(args.questions);
      if (uniquenessError !== null) return errorResult(uniquenessError);
      if (args.background) detach?.(backgroundAck(toolCall.id));
      return executeQuestion(deps, args, { toolCallId: toolCall.id, signal, turnId });
    },
  };
}

interface QuestionContext {
  readonly toolCallId: string;
  readonly signal: AbortSignal;
  readonly turnId?: number;
}

async function executeQuestion(
  deps: AskUserQuestionToolDeps,
  args: AskUserQuestionInput,
  ctx: QuestionContext,
): Promise<ToolResult> {
  try {
    const result = await requestQuestion(deps, args, ctx);
    const normalized = normalizeQuestionResult(result);
    if (normalized === null || Object.keys(normalized.answers).length === 0) {
      deps.track('question_dismissed');
      return dismissedQuestionResult();
    }
    deps.track('question_answered', {
      answered: Object.keys(normalized.answers).length,
      method: normalized.method,
    });
    return textResult(JSON.stringify({ answers: normalized.answers }));
  } catch (error) {
    if (isAbortError(error) || ctx.signal.aborted) throw error;
    if (isNotImplementedError(error)) return errorResult(QUESTION_UNSUPPORTED_FAILURE_MESSAGE);
    return dismissedQuestionResult();
  }
}

function requestQuestion(
  deps: AskUserQuestionToolDeps,
  args: AskUserQuestionInput,
  { toolCallId, signal, turnId }: QuestionContext,
): Promise<QuestionResult> {
  const id = `question_${crypto.randomUUID()}`;
  const tags: InteractionTags = {
    [INTERACTION_TAG_AGENT_ID]: deps.agentId,
    [INTERACTION_TAG_SESSION_ID]: deps.sessionId,
    [INTERACTION_TAG_TOOL_CALL_ID]: toolCallId,
  };
  if (!args.background && turnId !== undefined) tags[INTERACTION_TAG_TURN_ID] = turnId;
  const pending = deps.interactions
    .request<unknown, unknown>({
      id,
      kind: 'question',
      payload: {
        turnId,
        toolCallId,
        questions: args.questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options.map((o) => ({
            label: o.label,
            description: o.description,
          })),
          multi_select: q.multi_select,
        })),
      },
      tags,
    })
    .then((response) => (isInteractionCancellation(response) ? null : (response as QuestionResult)));
  if (signal.aborted) {
    deps.interactions.respond(id, null);
  } else {
    const onAbort = (): void => {
      deps.interactions.respond(id, null);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  }
  return pending;
}

function backgroundAck(taskId: string): string {
  return (
    `task_id: ${taskId}\n` +
    'status: running\n' +
    'next_step: Continue your work; the answer arrives automatically in a later message. Use TaskStop only to cancel the question.'
  );
}

function dismissedQuestionResult(): ToolResult {
  return textResult(JSON.stringify({ answers: {}, note: QUESTION_DISMISSED_MESSAGE }));
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isNotImplementedError(error: unknown): boolean {
  return (
    error instanceof Error && (error as { readonly code?: unknown }).code === 'not_implemented'
  );
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
