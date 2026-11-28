export const MESSAGE_INDENT = '  ';

export const OSC133_ZONE_START = '\u001B]133;A\u0007';
export const OSC133_ZONE_END = '\u001B]133;B\u0007';
export const OSC133_ZONE_FINAL = '\u001B]133;C\u0007';

export const CHROME_GUTTER = 1;

export const RESULT_PREVIEW_LINES = 3;
export const SHELL_OUTPUT_PREVIEW_LINES = 10;
export const THINKING_PREVIEW_LINES = 2;
export const COMMAND_PREVIEW_LINES = 10;

export const DOCK_QUEUE_ROWS = 3;
export const DOCK_UPDATES_ROWS = 6;
export const DOCK_APPROVAL_ROWS = 6;
export const DOCK_UNDO_ROWS = 5;
export const DOCK_MODEL_SELECTOR_ROWS = 10;
export const DOCK_QUESTION_ROWS = 12;
export const DOCK_SESSION_PICKER_ROWS = 18;
export const DOCK_PREVIEW_ROWS = Number.POSITIVE_INFINITY;
export const UPDATES_PROMPT_FOLD_SCREEN_ROWS = 32;

export const TRUNCATION_ELLIPSIS = '…';
export const ANSI_ESCAPE_PATTERN = /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\))/g;
export const TAIL_WINDOW_UNITS_PER_CELL = 16;
export const OUTCOME_ROW_INDENT = '  ';
export const OUTCOME_MAX_LINES = 3;
export const OUTCOME_GLANCE_SAMPLES = 3;

export const RETRY_DETAIL_MAX_CHARS = 160;
export const ACTIVITY_DETAIL_INDENT = 4;

export const MAX_SUBAGENT_ACTIVITY_STEPS = 20;
export const SUBAGENT_STEP_TEXT_TAIL_CHARS = 4000;
export const SUBAGENT_TOOL_OUTPUT_MAX_CHARS = 8000;
export const SUBAGENT_ARG_STRING_MAX_CHARS = 16 * 1024;
export const SUBAGENT_PREVIEW_TEXT_MAX_CHARS = 8000;

export const MAX_FINAL_OUTPUT_LABEL_CHARS = 400;
export const MAX_FINAL_OUTPUT_LABEL_CODE_UNITS = 2_000;

export const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const BRAILLE_SPINNER_INTERVAL_MS = 80;

export const TRANSCRIPT_GROUP_SWEEP_START_DELAY_MS = 600;
export const TRANSCRIPT_GROUP_SWEEP_INTERVAL_MS = 4_000;
export const TRANSCRIPT_GROUP_SWEEP_DURATION_MS = 1_600;
export const TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH_RATIO = 0.2;
export const TRANSCRIPT_GROUP_SWEEP_MIN_HALF_WIDTH = 5;
export const TRANSCRIPT_GROUP_SWEEP_LIGHT_REST_TEXT_RATIO = 0.6;
export const TRANSCRIPT_GROUP_SWEEP_LIGHT_REST_MIN_CONTRAST = 4.5;
export const TRANSCRIPT_GROUP_FADE_HALF_LIFE_MS = 150;
export const TRANSCRIPT_GROUP_TAIL_ELAPSED_MS = 2_000;
export const TRANSCRIPT_GROUP_COUNT_DELAY_MS = 200;
export const TRANSCRIPT_TAIL_ENTER_MS = 1_000;
export const TRANSCRIPT_TAIL_THOUGHT_HOLD_MS = 2_000;
export const TRANSCRIPT_TAIL_MIN_NAME_COLUMNS = 12;
export const TRANSCRIPT_TAIL_TIMER_COLUMNS = ' · 99s'.length;
export const TRANSCRIPT_TAIL_THINKING_THROTTLE_MS = 150;
export const FOREGROUND_BASH_HINT_DELAY_MS = 10_000;
export const DETACH_HINT_TEXT = 'Press Ctrl+B to run in background';

export const MOON_SPINNER_FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
export const MOON_LOADER_FRAME_MS = 120;
