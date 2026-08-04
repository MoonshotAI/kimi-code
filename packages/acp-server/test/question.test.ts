import { describe, expect, it } from 'vitest';

import { outcomeToQuestionAnswer, questionItemToPermissionOptions } from '../src/question';

import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { QuestionItem } from '@moonshot-ai/agent-core-v2';

function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: 'selected', optionId } };
}

const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

const sampleQuestion: QuestionItem = {
  question: 'Pick a color',
  options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
};

describe('questionItemToPermissionOptions', () => {
  it('maps each option to an allow_once plus a trailing Skip reject', () => {
    const options = questionItemToPermissionOptions(sampleQuestion, 0);
    expect(options.map((o) => o.optionId)).toEqual([
      'q0_opt_0',
      'q0_opt_1',
      'q0_opt_2',
      'q0_skip',
    ]);
    expect(options[0]).toMatchObject({ name: 'Red', kind: 'allow_once' });
    expect(options.at(-1)).toMatchObject({ name: 'Skip', kind: 'reject_once' });
  });
});

describe('outcomeToQuestionAnswer', () => {
  it('returns the selected label keyed by the question text', () => {
    expect(outcomeToQuestionAnswer(sampleQuestion, selected('q0_opt_1'))).toEqual({
      'Pick a color': 'Green',
    });
  });

  it('returns null on cancel', () => {
    expect(outcomeToQuestionAnswer(sampleQuestion, cancelled)).toBeNull();
  });

  it('returns null on skip', () => {
    expect(outcomeToQuestionAnswer(sampleQuestion, selected('q0_skip'))).toBeNull();
  });

  it('returns null on an out-of-bounds or unknown optionId', () => {
    expect(outcomeToQuestionAnswer(sampleQuestion, selected('q0_opt_99'))).toBeNull();
    expect(outcomeToQuestionAnswer(sampleQuestion, selected('mystery'))).toBeNull();
  });
});
