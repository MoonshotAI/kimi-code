import type { QuestionRequest } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { QuestionController } from '#/tui/reverse-rpc/question/controller';
import { createQuestionAskHandler } from '#/tui/reverse-rpc/question/handler';

function questionEvent(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    toolCallId: 'q-1',
    questions: [
      {
        question: 'Q1?',
        options: [{ label: 'Alpha' }],
      },
    ],
    ...overrides,
  };
}

describe('question reverse-rpc', () => {
  it('QuestionController cancels pending requests with an empty answer list', async () => {
    const controller = new QuestionController();
    const pending = controller.show({
      id: 'req-1',
      tool_call_id: 'tc-1',
      questions: [],
    });

    controller.cancelAll('closed');

    await expect(pending).resolves.toEqual({ answers: [] });
  });

  it('normalizes question payloads and returns the selected answer', async () => {
    const controller = new QuestionController();
    const show = vi
      .spyOn(controller, 'show')
      .mockResolvedValue({ answers: ['Alpha'], method: 'number_key' });
    const handler = createQuestionAskHandler(controller);
    const event = questionEvent({
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
    });

    await expect(handler(event)).resolves.toEqual({
      answers: { 'Q1?': 'Alpha' },
      method: 'number_key',
    });
    expect(show).toHaveBeenCalledWith({
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

    show.mockResolvedValueOnce({ answers: [''] });
    await expect(handler(questionEvent())).resolves.toBeNull();

    show.mockRejectedValueOnce(new Error('boom'));
    await expect(handler(questionEvent())).resolves.toBeNull();
  });

  it('maps multiple question answers by question text', async () => {
    const controller = new QuestionController();
    const show = vi
      .spyOn(controller, 'show')
      .mockResolvedValue({ answers: ['Alpha', 'SQLite'], method: 'enter' });
    const handler = createQuestionAskHandler(controller);
    const event = questionEvent({
      toolCallId: 'call_question',
      questions: [
        {
          question: 'Q1?',
          options: [{ label: 'Alpha' }],
        },
        {
          question: 'Storage?',
          header: 'Store',
          options: [{ label: 'SQLite' }],
        },
      ],
    });

    await expect(handler(event)).resolves.toEqual({
      answers: {
        'Q1?': 'Alpha',
        'Storage?': 'SQLite',
      },
      method: 'enter',
    });
    expect(show).toHaveBeenCalledWith({
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
  });

  it('tracks the requesting agent until the question handler settles', async () => {
    const controller = new QuestionController();
    vi.spyOn(controller, 'show').mockRejectedValue(new Error('boom'));
    const token = Symbol('question');
    const tracker = {
      startInteraction: vi.fn(() => token),
      endInteraction: vi.fn(),
    };
    const handler = createQuestionAskHandler(controller, tracker);

    await expect(handler(questionEvent({ agentId: 'agent-1' }))).resolves.toBeNull();
    expect(tracker.startInteraction).toHaveBeenCalledWith({
      agentId: 'agent-1',
      kind: 'question',
    });
    expect(tracker.endInteraction).toHaveBeenCalledWith(token);
  });
});
