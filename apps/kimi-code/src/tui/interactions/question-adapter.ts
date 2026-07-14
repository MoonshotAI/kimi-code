import type { CoreQuestionRequest, QuestionResult } from '#/core/index';

import type { QuestionPanelData, QuestionPanelResponse } from '#/tui/interactions/types';

/**
 * Project a core question request into the dialog view payload. `id` is the
 * pending-interaction id used to correlate the dialog with the session broker;
 * it falls back to the request's own correlation fields.
 */
export function adaptQuestionRequest(request: CoreQuestionRequest, id?: string): QuestionPanelData {
  const panelId =
    id ??
    request.id ??
    request.toolCallId ??
    (request.turnId === undefined ? 'question' : `question-${String(request.turnId)}`);
  return {
    id: panelId,
    tool_call_id: request.toolCallId ?? panelId,
    questions: request.questions.map((question) => ({
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

/**
 * Map the dialog answers back to the core result. Returns `null` when nothing
 * was answered (Esc / empty submit), which the controller turns into a
 * `dismiss`.
 */
export function adaptQuestionAnswers(
  request: CoreQuestionRequest,
  response: QuestionPanelResponse,
): QuestionResult {
  const result: Record<string, string | true> = {};
  for (let i = 0; i < request.questions.length; i++) {
    const question = request.questions[i];
    const answer = response.answers[i];
    if (question === undefined || typeof answer !== 'string' || answer.length === 0) continue;
    result[question.question] = answer;
  }
  return Object.keys(result).length > 0
    ? { answers: result, method: response.method }
    : null;
}
