export const SURVEY_IDLE_EVALUATION_DELAY_MS = 2000;

export const SURVEY_IDLE_STABILITY_MS = 2000;

export const SURVEY_MOUNT_PROTECTION_MS = 600;

export const SURVEY_DIGIT_DEBOUNCE_MS = 400;

export const SURVEY_PENDING_UNDO_WINDOW_MS = 3000;

export const SURVEY_THANKS_DURATION_MS = 5000;

export const SURVEY_CONFIG_REFRESH_INTERVAL_MS = 3_600_000;

export const SURVEY_MIN_OPTIONS_WIDTH = 12;

export const SURVEY_QUESTION = 'How is Kimi doing this session? (optional)';

export const SURVEY_OPTION_LABELS = ['1: Bad', '2: Fine', '3: Good', '0: Dismiss'] as const;

export const SURVEY_OPTION_GAP = 2;

const SURVEY_SPACER_ROWS = 1;
const SURVEY_PANEL_HORIZONTAL_CHROME = 2;
const SURVEY_EDITOR_MIN_ROWS = 3;
const SURVEY_TRANSCRIPT_MIN_ROWS = 1;
const SURVEY_FOOTER_MIN_ROWS = 1;

export function surveyMinTotalHeight(contentWidth: number): number {
  const innerWidth = Math.max(1, contentWidth - SURVEY_PANEL_HORIZONTAL_CHROME);
  const inlineWidth =
    SURVEY_OPTION_LABELS.reduce((total, label) => total + label.length, 0) +
    SURVEY_OPTION_GAP * (SURVEY_OPTION_LABELS.length - 1);
  const optionsRows = innerWidth >= inlineWidth ? 1 : SURVEY_OPTION_LABELS.length;
  return (
    SURVEY_SPACER_ROWS +
    surveyQuestionRows(innerWidth) +
    optionsRows +
    SURVEY_EDITOR_MIN_ROWS +
    SURVEY_TRANSCRIPT_MIN_ROWS +
    SURVEY_FOOTER_MIN_ROWS
  );
}

function surveyQuestionRows(width: number): number {
  let rows = 1;
  let lineLength = 0;
  for (const word of SURVEY_QUESTION.split(' ')) {
    if (lineLength > 0 && lineLength + 1 + word.length > width) {
      rows += 1;
      lineLength = word.length;
    } else {
      lineLength += (lineLength > 0 ? 1 : 0) + word.length;
    }
  }
  return rows;
}

export const SURVEY_ORDERED_LIST_START = /^[ \t]*\d{1,2}[.)][ \t]/m;

export const SURVEY_SINGLE_OPTION_DIGIT = /^[0-3]$/;

export const SURVEY_OPTION_COUNT = 4;

export const SURVEY_DISMISS_OPTION_INDEX = SURVEY_OPTION_COUNT - 1;

export const SURVEY_DIGIT_RESPONSES: Record<string, 'bad' | 'fine' | 'good' | undefined> = {
  '1': 'bad',
  '2': 'fine',
  '3': 'good',
};
