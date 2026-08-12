// Continuation indent for transcript rows that use a two-cell leading marker.
export const MESSAGE_INDENT = '  ';

// OSC 133 semantic-zone markers (FinalTerm/shell-integration protocol):
// zero-width escape sequences prefixed onto the first/last rendered line of
// transcript messages. The fullscreen renderer strips them at paint and uses
// the A marker for previous/next-prompt navigation (Ctrl-Shift-Up/Down); in
// regular mode they pass through to native scrollback invisibly.
export const OSC133_ZONE_START = '\x1b]133;A\x07';
export const OSC133_ZONE_END = '\x1b]133;B\x07';
export const OSC133_ZONE_FINAL = '\x1b]133;C\x07';

// Outer left/right padding applied to the transcript, panels, and the
// statusline so the chrome's left edge lines up with the input box's
// interior (the `>` prompt). The editor itself stays at column 0 — its
// vertical borders are the visual anchor everything else aligns against.
export const CHROME_GUTTER = 1;

// Shared preview caps used by thinking, tool results, and shell snippets.
export const RESULT_PREVIEW_LINES = 3;
export const THINKING_PREVIEW_LINES = 2;
export const COMMAND_PREVIEW_LINES = 10;

// Cap on the step-retry detail line under the waiting spinner, so huge
// provider error bodies (occasionally whole HTML error pages) can't flood
// the activity pane.
export const RETRY_DETAIL_MAX_CHARS = 160;
// Left indent (cells) for the detail line under the waiting spinner, aligning
// it with the label text: 1 (the spinner Text's own paddingX) + 2 (moon
// frame) + 1 (space between frame and label).
export const ACTIVITY_DETAIL_INDENT = 4;

// Retention caps for the subagent activity store (background-agent detail
// view): only the most recent steps are kept, older steps are discarded
// whole, and per-step text / per-call output keep bounded tails.
export const MAX_SUBAGENT_ACTIVITY_STEPS = 20;
export const SUBAGENT_STEP_TEXT_TAIL_CHARS = 4000;
export const SUBAGENT_TOOL_OUTPUT_MAX_CHARS = 8000;
// Cap on individual string argument values kept in a record (Write/Edit
// carry whole-file contents). Only header summaries and the Edit/Write line
// chips read args, so long values are truncated; chips become approximate
// beyond the cap.
export const SUBAGENT_ARG_STRING_MAX_CHARS = 16 * 1024;

// Animation frames are shared by the login/update loaders and live thinking.
export const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const BRAILLE_SPINNER_INTERVAL_MS = 80;

export const MOON_SPINNER_FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
export const MOON_SPINNER_INTERVAL_MS = 120;
