/**
 * Question adapter unit tests (W8.2 / Chain 6).
 *
 * Covers the 5-kind ↔ Record<string, string | true> normalization: wire
 * answers arrive keyed by synthesized ids (`q_<idx>` / `opt_<q>_<o>`), and
 * `toAgentCoreResponse` translates them back to question text / option labels
 * using the original broker request, so the model sees self-explanatory text
 * instead of positional ids.
 */

import { describe, expect, it } from 'vitest';

import type { QuestionRequest as InProcessQuestionRequest } from '../../src';

import {
  questionDismissedResult as dismissedResult,
  questionToAgentCoreResponse as toAgentCoreResponse,
  questionToBrokerRequest as toBrokerRequest,
} from '../../src/services';

describe('question-adapter · toBrokerRequest (in-process → protocol)', () => {
  const inProc: InProcessQuestionRequest = {
    turnId: 7,
    toolCallId: 'tc_q',
    questions: [
      {
        question: 'Which animal?',
        header: 'Pets',
        body: 'pick one',
        options: [
          { label: 'Cat' },
          { label: 'Dog' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which colors?',
        options: [
          { label: 'Red' },
          { label: 'Green' },
          { label: 'Blue' },
        ],
        multiSelect: true,
        otherLabel: 'Other',
      },
    ],
  };

  it('synthesizes stable q_<idx> + opt_<parent>_<opt> ids and maps fields', () => {
    const protoReq = toBrokerRequest(inProc, {
      questionId: '01J_QUESTION',
      sessionId: 'sess_x',
      createdAt: '2026-06-04T10:30:00.000Z',
    });

    expect(protoReq.question_id).toBe('01J_QUESTION');
    expect(protoReq.session_id).toBe('sess_x');
    expect(protoReq.turn_id).toBe(7);
    expect(protoReq.tool_call_id).toBe('tc_q');

    expect(protoReq.questions).toHaveLength(2);
    expect(protoReq.questions[0]?.id).toBe('q_0');
    expect(protoReq.questions[0]?.options[0]?.id).toBe('opt_0_0');
    expect(protoReq.questions[0]?.options[1]?.id).toBe('opt_0_1');
    expect(protoReq.questions[0]?.header).toBe('Pets');
    expect(protoReq.questions[0]?.body).toBe('pick one');
    expect(protoReq.questions[0]?.multi_select).toBe(false);
    // Other affordance is always on, even when the SDK item has no otherLabel.
    expect(protoReq.questions[0]?.allow_other).toBe(true);
    expect(protoReq.questions[0]?.other_label).toBeUndefined();

    expect(protoReq.questions[1]?.id).toBe('q_1');
    expect(protoReq.questions[1]?.options.map((o) => o.id)).toEqual([
      'opt_1_0',
      'opt_1_1',
      'opt_1_2',
    ]);
    expect(protoReq.questions[1]?.multi_select).toBe(true);
    expect(protoReq.questions[1]?.allow_other).toBe(true);
    expect(protoReq.questions[1]?.other_label).toBe('Other');
  });

  it('omits turn_id / tool_call_id when SDK does not provide them', () => {
    const minimal: InProcessQuestionRequest = {
      questions: [
        {
          question: '?',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    };
    const protoReq = toBrokerRequest(minimal, {
      questionId: 'q',
      sessionId: 's',
      createdAt: '2026-06-04T10:30:00.000Z',
    });
    expect(protoReq.turn_id).toBeUndefined();
    expect(protoReq.tool_call_id).toBeUndefined();
  });
});

describe('question-adapter · toAgentCoreResponse · id → text translation', () => {
  /** Broker request whose synthesized ids the answers below refer to. */
  const request = toBrokerRequest(
    {
      questions: [
        {
          question: 'Which animal?',
          options: [{ label: 'Cat' }, { label: 'Dog' }],
        },
        {
          question: 'Which colors?',
          options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
          multiSelect: true,
        },
      ],
    },
    {
      questionId: '01J_QUESTION',
      sessionId: 'sess_x',
      createdAt: '2026-06-04T10:30:00.000Z',
    },
  );

  it("'single' → answers[question text] = option label", () => {
    const inProc = toAgentCoreResponse(
      { answers: { q_0: { kind: 'single', option_id: 'opt_0_1' } } },
      request,
    );
    expect(inProc.answers).toEqual({ 'Which animal?': 'Dog' });
  });

  it("'multi' → answers[question text] = labels.join(', ')", () => {
    const inProc = toAgentCoreResponse(
      {
        answers: {
          q_1: { kind: 'multi', option_ids: ['opt_1_0', 'opt_1_2'] },
        },
      },
      request,
    );
    expect(inProc.answers).toEqual({ 'Which colors?': 'Red, Blue' });
  });

  it("'other' → answers[question text] = free text verbatim", () => {
    const inProc = toAgentCoreResponse(
      { answers: { q_0: { kind: 'other', text: 'Hippopotamus' } } },
      request,
    );
    expect(inProc.answers).toEqual({ 'Which animal?': 'Hippopotamus' });
  });

  it("'multi_with_other' → [...labels, other_text].join(', ')", () => {
    const inProc = toAgentCoreResponse(
      {
        answers: {
          q_1: {
            kind: 'multi_with_other',
            option_ids: ['opt_1_0', 'opt_1_1'],
            other_text: 'Custom',
          },
        },
      },
      request,
    );
    expect(inProc.answers).toEqual({ 'Which colors?': 'Red, Green, Custom' });
  });

  it("'skipped' → entry OMITTED entirely from the record", () => {
    const inProc = toAgentCoreResponse(
      {
        answers: {
          q_0: { kind: 'single', option_id: 'opt_0_0' },
          q_1: { kind: 'skipped' },
        },
      },
      request,
    );
    expect(inProc.answers).toEqual({ 'Which animal?': 'Cat' });
    expect(Object.keys(inProc.answers)).not.toContain('Which colors?');
    expect(Object.keys(inProc.answers)).not.toContain('q_1');
  });

  it('keeps unknown qids / option ids verbatim instead of dropping the answer (stale client)', () => {
    const inProc = toAgentCoreResponse(
      {
        answers: {
          q_0: { kind: 'single', option_id: 'opt_0_9' },
          q_9: { kind: 'single', option_id: 'opt_9_0' },
        },
      },
      request,
    );
    expect(inProc.answers).toEqual({
      'Which animal?': 'opt_0_9',
      q_9: 'opt_9_0',
    });
  });

  it("keeps a cross-question option id verbatim instead of resolving another question's label", () => {
    // opt_0_0 is 'Cat' — an option of question 0, never offered for question 1.
    // Translating it would hand the model a plausible-looking answer that was
    // never on the list; the raw id stays diagnosable.
    const inProc = toAgentCoreResponse(
      {
        answers: {
          q_1: { kind: 'single', option_id: 'opt_0_0' },
        },
      },
      request,
    );
    expect(inProc.answers).toEqual({ 'Which colors?': 'opt_0_0' });
  });

  it('resolves in-question ids and keeps cross-question ids verbatim within one multi answer', () => {
    const inProc = toAgentCoreResponse(
      {
        answers: {
          q_1: { kind: 'multi', option_ids: ['opt_1_0', 'opt_0_1'] },
        },
      },
      request,
    );
    expect(inProc.answers).toEqual({ 'Which colors?': 'Red, opt_0_1' });
  });

  it('falls back to raw ids when no request is available (defensive path)', () => {
    const inProc = toAgentCoreResponse(
      {
        answers: {
          q_0: { kind: 'single', option_id: 'opt_0_1' },
          q_1: { kind: 'multi', option_ids: ['opt_1_0', 'opt_1_2'] },
        },
      },
      undefined,
    );
    expect(inProc.answers).toEqual({
      q_0: 'opt_0_1',
      q_1: 'opt_1_0, opt_1_2',
    });
  });

  it('handles a mixed response with one skipped (e2e prompt acceptance)', () => {
    const inProc = toAgentCoreResponse(
      {
        answers: {
          q_0: { kind: 'other', text: 'Hippopotamus' },
          q_1: { kind: 'skipped' },
        },
        method: 'click',
      },
      request,
    );
    expect(inProc.answers).toEqual({ 'Which animal?': 'Hippopotamus' });
    // method 'click' is NOT in agent-core's in-process method union — dropped.
    expect((inProc as { method?: string }).method).toBeUndefined();
  });

  it("keeps agent-core method values like 'enter' / 'space' / 'number_key'", () => {
    const inProc = toAgentCoreResponse(
      {
        answers: { q_0: { kind: 'skipped' } },
        method: 'enter',
      },
      request,
    );
    expect((inProc as { method?: string }).method).toBe('enter');
  });

  it('produces an empty answers record when ALL questions are skipped (partial-answer marker, NOT dismiss)', () => {
    const inProc = toAgentCoreResponse(
      {
        answers: {
          q_0: { kind: 'skipped' },
          q_1: { kind: 'skipped' },
        },
      },
      request,
    );
    expect(inProc.answers).toEqual({});
    // Distinct from dismissedResult() which returns null.
    expect(inProc).not.toBeNull();
  });
});

describe('question-adapter · dismissedResult helper', () => {
  it('returns null (== SCHEMAS §6.3 dismiss path)', () => {
    expect(dismissedResult()).toBeNull();
  });
});
