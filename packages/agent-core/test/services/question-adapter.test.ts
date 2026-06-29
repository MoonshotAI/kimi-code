/**
 * Question adapter unit tests (W8.2 / Chain 6).
 *
 * Covers SCHEMAS §6.4 5-kind ↔ Record<string, string | true> normalization
 * verbatim.
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

describe('question-adapter · toAgentCoreResponse · SCHEMAS §6.4 verbatim', () => {
  it("'single' → answers[qid] = option_id", () => {
    const inProc = toAgentCoreResponse({
      answers: { q_0: { kind: 'single', option_id: 'opt_0_1' } },
    });
    expect(inProc.answers).toEqual({ q_0: 'opt_0_1' });
  });

  it("'multi' → answers[qid] = option_ids.join(',')  (lossy)", () => {
    const inProc = toAgentCoreResponse({
      answers: {
        q_0: { kind: 'multi', option_ids: ['opt_0_0', 'opt_0_2'] },
      },
    });
    expect(inProc.answers).toEqual({ q_0: 'opt_0_0,opt_0_2' });
  });

  it("'other' → answers[qid] = text", () => {
    const inProc = toAgentCoreResponse({
      answers: { q_0: { kind: 'other', text: 'Hippopotamus' } },
    });
    expect(inProc.answers).toEqual({ q_0: 'Hippopotamus' });
  });

  it("'multi_with_other' → [...option_ids, other_text].join(',')", () => {
    const inProc = toAgentCoreResponse({
      answers: {
        q_0: {
          kind: 'multi_with_other',
          option_ids: ['opt_0_0', 'opt_0_1'],
          other_text: 'Custom',
        },
      },
    });
    expect(inProc.answers).toEqual({ q_0: 'opt_0_0,opt_0_1,Custom' });
  });

  it("'skipped' → entry OMITTED entirely from the record", () => {
    const inProc = toAgentCoreResponse({
      answers: {
        q_0: { kind: 'single', option_id: 'opt_0_0' },
        q_1: { kind: 'skipped' },
        q_2: { kind: 'other', text: 'Custom' },
      },
    });
    expect(inProc.answers).toEqual({
      q_0: 'opt_0_0',
      q_2: 'Custom',
    });
    expect(Object.keys(inProc.answers)).not.toContain('q_1');
  });

  it('handles a mixed 4-item response with one skipped (e2e prompt acceptance)', () => {
    const inProc = toAgentCoreResponse({
      answers: {
        q_0: { kind: 'single', option_id: 'opt_0_0' },
        q_1: { kind: 'multi', option_ids: ['opt_1_0', 'opt_1_1'] },
        q_2: { kind: 'other', text: 'Hippopotamus' },
        q_3: { kind: 'skipped' },
      },
      method: 'click',
    });
    expect(inProc.answers).toEqual({
      q_0: 'opt_0_0',
      q_1: 'opt_1_0,opt_1_1',
      q_2: 'Hippopotamus',
    });
    // method 'click' is NOT in agent-core's in-process method union — dropped.
    expect((inProc as { method?: string }).method).toBeUndefined();
  });

  it("keeps agent-core method values like 'enter' / 'space' / 'number_key'", () => {
    const inProc = toAgentCoreResponse({
      answers: { q_0: { kind: 'skipped' } },
      method: 'enter',
    });
    expect((inProc as { method?: string }).method).toBe('enter');
  });

  it('produces an empty answers record when ALL questions are skipped (partial-answer marker, NOT dismiss)', () => {
    const inProc = toAgentCoreResponse({
      answers: {
        q_0: { kind: 'skipped' },
        q_1: { kind: 'skipped' },
      },
    });
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
