import type { CoreQuestionRequest } from '#/core/index';
import { describe, expect, it } from 'vitest';

import { adaptQuestionAnswers, adaptQuestionRequest } from '#/tui/interactions/question-adapter';

function questionRequest(overrides: Partial<CoreQuestionRequest> = {}): CoreQuestionRequest {
  return {
    toolCallId: 'q-1',
    questions: [{ question: 'Q1?', options: [{ label: 'Alpha' }] }],
    ...overrides,
  };
}

describe('question adapter', () => {
  it('normalizes question payloads', () => {
    const adapted = adaptQuestionRequest(
      questionRequest({
        questions: [
          {
            question: 'Q1?',
            header: 'Pick',
            body: 'Choose one',
            multiSelect: true,
            otherLabel: 'Other',
            otherDescription: 'Type a custom answer',
            options: [{ label: 'Alpha', description: 'First option' }],
          },
        ],
      }),
    );

    expect(adapted).toEqual({
      id: 'q-1',
      tool_call_id: 'q-1',
      questions: [
        {
          question: 'Q1?',
          header: 'Pick',
          body: 'Choose one',
          multi_select: true,
          other_label: 'Other',
          other_description: 'Type a custom answer',
          options: [{ label: 'Alpha', description: 'First option' }],
        },
      ],
    });
  });

  it('maps multiple answers by question text', () => {
    const request = questionRequest({
      toolCallId: 'call_question',
      questions: [
        { question: 'Q1?', options: [{ label: 'Alpha' }] },
        { question: 'Storage?', header: 'Store', options: [{ label: 'SQLite' }] },
      ],
    });
    const adapted = adaptQuestionRequest(request);
    expect(adapted).toEqual({
      id: 'call_question',
      tool_call_id: 'call_question',
      questions: [
        {
          question: 'Q1?',
          header: undefined,
          body: undefined,
          multi_select: false,
          other_label: undefined,
          other_description: undefined,
          options: [{ label: 'Alpha', description: undefined }],
        },
        {
          question: 'Storage?',
          header: 'Store',
          body: undefined,
          multi_select: false,
          other_label: undefined,
          other_description: undefined,
          options: [{ label: 'SQLite', description: undefined }],
        },
      ],
    });

    expect(
      adaptQuestionAnswers(request, { answers: ['Alpha', 'SQLite'], method: 'enter' }),
    ).toEqual({
      answers: { 'Q1?': 'Alpha', 'Storage?': 'SQLite' },
      method: 'enter',
    });
  });

  it('returns null when no answers are provided', () => {
    const request = questionRequest();
    expect(adaptQuestionAnswers(request, { answers: [''] })).toBeNull();
  });

  it('uses an explicit pending id when one is supplied', () => {
    const adapted = adaptQuestionRequest(questionRequest(), 'interaction-1');
    expect(adapted.id).toBe('interaction-1');
  });
});
