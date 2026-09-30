import type { QuestionItem } from '@moonshot-ai/harness-core';

import type {
  QuestionPanelData,
  QuestionPanelResponse,
} from '#/tui/reverse-rpc/types';

export interface QuestionInteractionPayload {
  readonly questions: readonly QuestionItem[];
  readonly toolCallId?: string;
}

export function adaptQuestionPayload(
  interactionId: string,
  payload: QuestionInteractionPayload,
): QuestionPanelData {
  return {
    id: interactionId,
    tool_call_id: payload.toolCallId ?? interactionId,
    questions: payload.questions.map((question) => ({
      question: question.question,
      header: question.header.length > 0 ? question.header : undefined,
      multi_select: question.multi_select,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description.length > 0 ? option.description : undefined,
      })),
    })),
  };
}

export function adaptQuestionAnswers(
  payload: QuestionInteractionPayload,
  response: QuestionPanelResponse,
): { readonly answers: Record<string, string> } {
  const result: Record<string, string> = {};
  for (let i = 0; i < payload.questions.length; i++) {
    const question = payload.questions[i];
    const answer = response.answers[i];
    if (question === undefined || typeof answer !== 'string' || answer.length === 0) continue;
    result[question.question] = answer;
  }
  return { answers: result };
}
