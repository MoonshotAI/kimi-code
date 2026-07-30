/**
 * `tools` domain (L7) — `IAskUserQuestionTool` contract (the
 * `AskUserQuestion` tool).
 *
 * Public contract of the `AskUserQuestion` structured user question tool:
 * the input zod schemas the model-facing parameters are derived from
 * (including the background-asking variant and the uniqueness validation
 * shared by both the schema refinement and the runtime re-check) and the
 * `IAskUserQuestionTool` DI decorator that the implementation
 * (`askUserQuestionTool.ts`) registers against via `registerAgentToolService`.
 * Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

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

const AskUserQuestionInputBaseSchema = z.object({
  questions: z
    .array(QuestionItemSchema)
    .min(1)
    .max(4)
    .describe('The questions to ask the user (1-4 questions).'),
});

export const AskUserQuestionInputSchemaWithBackground = AskUserQuestionInputBaseSchema.extend({
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


export interface IAskUserQuestionTool extends AgentTool<AskUserQuestionInput> {
  readonly _serviceBrand: undefined;
}
export const IAskUserQuestionTool = createDecorator<IAskUserQuestionTool>('askUserQuestionTool');
