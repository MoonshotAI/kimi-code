import type { QuestionHandler, QuestionRequest, QuestionResult } from '@moonshot-ai/kimi-code-sdk';

import type {
  QuestionPanelData,
  QuestionPanelResponse,
} from '#/tui/reverse-rpc/types';

import type { QuestionController } from './controller';

export function createQuestionAskHandler(controller: QuestionController): QuestionHandler {
  return async (event): Promise<QuestionResult> => {
    try {
      const answers = await controller.show(adaptQuestionRequest(event));
      return adaptQuestionAnswers(event, answers);
    } catch {
      return null;
    }
  };
}

export function adaptQuestionRequest(event: QuestionRequest): QuestionPanelData {
  const id =
    event.toolCallId ??
    (event.turnId === undefined ? 'question' : `question-${String(event.turnId)}`);
  return {
    id,
    tool_call_id: id,
    questions: event.questions.map((question) => ({
      question: question.question,
      header: question.header,
      body: question.body,
      multi_select: question.multiSelect ?? false,
      other_label: question.otherLabel,
      other_description: question.otherDescription,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
    })),
  };
}

export function adaptQuestionAnswers(
  event: QuestionRequest,
  response: QuestionPanelResponse,
): QuestionResult {
  const result: Record<string, string | true> = {};
  for (let i = 0; i < event.questions.length; i++) {
    const question = event.questions[i];
    const answer = response.answers[i];
    if (question === undefined || typeof answer !== 'string' || answer.length === 0) continue;
    result[question.question] = answer;
  }
  return Object.keys(result).length > 0
    ? { answers: result, method: response.method }
    : null;
}
