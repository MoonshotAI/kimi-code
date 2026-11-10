import { SURVEY_MIN_OPTIONS_WIDTH, surveyMinTotalHeight } from '../constant/survey';

export type SurveyUiVetoReason =
  | 'ordered-list-ambiguity'
  | 'prompt-active'
  | 'editor-bash-active'
  | 'editor-autocomplete-active'
  | 'external-editor-active'
  | 'terminal-too-narrow'
  | 'terminal-too-short';

export interface SurveyUiVetoInput {
  readonly lastUserMessageStartsOrderedList: boolean;
  readonly promptActive: boolean;
  readonly editorBashActive: boolean;
  readonly editorAutocompleteActive: boolean;
  readonly externalEditorActive: boolean;
  readonly terminalWidth: number;
  readonly terminalHeight: number;
}

export function surveyUiVeto(input: SurveyUiVetoInput): SurveyUiVetoReason | undefined {
  if (input.lastUserMessageStartsOrderedList) return 'ordered-list-ambiguity';
  if (input.promptActive) return 'prompt-active';
  if (input.editorBashActive) return 'editor-bash-active';
  if (input.editorAutocompleteActive) return 'editor-autocomplete-active';
  if (input.externalEditorActive) return 'external-editor-active';
  if (input.terminalWidth < SURVEY_MIN_OPTIONS_WIDTH) return 'terminal-too-narrow';
  if (input.terminalHeight < surveyMinTotalHeight(input.terminalWidth)) return 'terminal-too-short';
  return undefined;
}
