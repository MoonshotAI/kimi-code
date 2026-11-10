import { describe, expect, it } from 'vitest';

import { surveyUiVeto, type SurveyUiVetoInput } from '#/tui/utils/survey-policy';

function passing(overrides: Partial<SurveyUiVetoInput> = {}): SurveyUiVetoInput {
  return {
    lastUserMessageStartsOrderedList: false,
    promptActive: false,
    editorBashActive: false,
    editorAutocompleteActive: false,
    externalEditorActive: false,
    terminalWidth: 120,
    terminalHeight: 24,
    ...overrides,
  };
}

describe('surveyUiVeto', () => {
  it('lets the evaluation through when nothing on screen competes with the survey', () => {
    expect(surveyUiVeto(passing())).toBeUndefined();
  });

  it.each<[Partial<SurveyUiVetoInput>, string]>([
    [{ lastUserMessageStartsOrderedList: true }, 'ordered-list-ambiguity'],
    [{ promptActive: true }, 'prompt-active'],
    [{ editorBashActive: true }, 'editor-bash-active'],
    [{ editorAutocompleteActive: true }, 'editor-autocomplete-active'],
    [{ externalEditorActive: true }, 'external-editor-active'],
    [{ terminalWidth: 10 }, 'terminal-too-narrow'],
    [{ terminalHeight: 7 }, 'terminal-too-short'],
    [{ terminalWidth: 12, terminalHeight: 14 }, 'terminal-too-short'],
    [{ terminalWidth: 16, terminalHeight: 13 }, 'terminal-too-short'],
  ])('vetoes with %j → %s', (overrides, reason) => {
    expect(surveyUiVeto(passing(overrides))).toBe(reason);
  });

  it('reports the first veto in check order', () => {
    expect(
      surveyUiVeto(passing({ promptActive: true, editorBashActive: true, terminalWidth: 10 })),
    ).toBe('prompt-active');
  });
});
