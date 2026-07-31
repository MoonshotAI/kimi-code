/**
 * Scenario: the QuestionDialog form state is projected into the AskUserQuestion answers contract.
 * Responsibilities: verify single/multi-select resolution, custom text precedence, join format,
 * and unanswered-question omission one case at a time.
 * Wiring: the pure builder and real protocol types are used directly; there are no stubs.
 * Run: pnpm exec vitest run --config apps/vscode/vitest.config.ts apps/vscode/test/question-answers.test.ts
 */

import { describe, expect, it } from 'vitest';

import type { QuestionItem } from '../shared/legacy-sdk';
import {
  buildQuestionAnswers,
  type QuestionFormState,
} from '../webview-ui/src/lib/question-answers';

function question(overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    question: 'Pick a color?',
    header: 'Style',
    options: [
      { label: 'Red', description: '' },
      { label: 'Blue', description: '' },
      { label: 'Green', description: '' },
    ],
    ...overrides,
  };
}

function form(overrides: Partial<QuestionFormState> = {}): QuestionFormState {
  return { single: {}, multi: {}, custom: {}, ...overrides };
}

describe('buildQuestionAnswers (projects the form state into the answers contract)', () => {
  it('maps a single-select choice to the option label keyed by question text', () => {
    const answers = buildQuestionAnswers([question()], form({ single: { 0: 1 } }));

    expect(answers).toEqual({ 'Pick a color?': 'Blue' });
  });

  it('lets custom text win over a single-select choice', () => {
    const answers = buildQuestionAnswers(
      [question()],
      form({ single: { 0: 1 }, custom: { 0: '  Chartreuse  ' } }),
    );

    expect(answers).toEqual({ 'Pick a color?': 'Chartreuse' });
  });

  it("joins multi-select labels with ', ' following the TUI convention", () => {
    const answers = buildQuestionAnswers(
      [question({ multi_select: true })],
      form({ multi: { 0: new Set([2, 0]) } }),
    );

    expect(answers).toEqual({ 'Pick a color?': 'Red, Green' });
  });

  it('appends custom text as an extra label for multi-select questions', () => {
    const answers = buildQuestionAnswers(
      [question({ multi_select: true })],
      form({ multi: { 0: new Set([1]) }, custom: { 0: 'Purple' } }),
    );

    expect(answers).toEqual({ 'Pick a color?': 'Blue, Purple' });
  });

  it('omits questions without any answer', () => {
    const answers = buildQuestionAnswers(
      [question({ question: 'First?' }), question({ question: 'Second?' })],
      form({ single: { 1: 0 } }),
    );

    expect(answers).toEqual({ 'Second?': 'Red' });
  });

  it('returns an empty record when nothing is answered (dismiss semantics)', () => {
    const answers = buildQuestionAnswers(
      [question(), question({ question: 'Another?', multi_select: true })],
      form({ multi: { 1: new Set() }, custom: { 0: '   ' } }),
    );

    expect(answers).toEqual({});
  });

  it('ignores out-of-range selections and empty option lists', () => {
    const answers = buildQuestionAnswers(
      [question(), question({ question: 'Empty?', options: [] })],
      form({ single: { 0: 7, 1: 0 } }),
    );

    expect(answers).toEqual({});
  });
});
