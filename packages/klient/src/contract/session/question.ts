/**
 * `sessionQuestionService` — ask-user request broker. Mirrors
 * `agent-core-v2/session/question/question.ts` (the in-process camelCase
 * representation; the snake_case protocol shape is adapted at the edge).
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const questionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});

export const questionItemSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  body: z.string().optional(),
  options: z.array(questionOptionSchema),
  multiSelect: z.boolean().optional(),
  otherLabel: z.string().optional(),
  otherDescription: z.string().optional(),
});

/** `QuestionAnswers = Record<string, string | true>`. */
export const questionAnswersSchema = z.record(
  z.string(),
  z.union([z.string(), z.literal(true)]),
);

export const questionResponseSchema = z.object({
  answers: questionAnswersSchema,
  method: z.enum(['enter', 'space', 'number_key']).optional(),
});

/** `QuestionResult = null | QuestionAnswers | QuestionResponse`. */
export const questionResultSchema = z.union([
  z.null(),
  questionAnswersSchema,
  questionResponseSchema,
]);

export const questionRequestSchema = z.object({
  id: z.string().optional(),
  turnId: z.number().optional(),
  toolCallId: z.string().optional(),
  questions: z.array(questionItemSchema),
});

export const sessionQuestionContract = {
  listPending: { input: z.tuple([]), output: z.array(questionRequestSchema) },
  answer: { input: z.tuple([z.string(), questionResultSchema]), output: noResult },
  dismiss: { input: z.tuple([z.string()]), output: noResult },
} satisfies ServiceContract;
