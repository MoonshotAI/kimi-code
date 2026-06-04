import { BEL, ESC, ST } from "#/constant/terminal";

export { BEL, ESC, ST } from "#/constant/terminal";

// Terminal theme reporting uses private CSI sequences: enable reporting,
// query once, then parse dark/light reports from the input stream.
export const QUERY_TERMINAL_THEME = `${ESC}[?996n`;
export const TERMINAL_THEME_DARK = `${ESC}[?997;1n`;
export const TERMINAL_THEME_LIGHT = `${ESC}[?997;2n`;
export const ENABLE_TERMINAL_THEME_REPORTING = `${ESC}[?2031h`;
export const DISABLE_TERMINAL_THEME_REPORTING = `${ESC}[?2031l`;

// Xterm-style focus reporting. Input listeners consume these bytes so
// they do not leak into the editor.
export const TERMINAL_FOCUS_IN = `${ESC}[I`;
export const TERMINAL_FOCUS_OUT = `${ESC}[O`;
export const ENABLE_TERMINAL_FOCUS_REPORTING = `${ESC}[?1004h`;
export const DISABLE_TERMINAL_FOCUS_REPORTING = `${ESC}[?1004l`;

// Standard OSC 11 background-color query. The response regex intentionally
// allows a missing leading ESC because terminals can echo replies alongside
// other raw input, but it requires an OSC terminator so fragmented color
// channels are not parsed as complete replies.
export const OSC11_QUERY = `${ESC}]11;?${BEL}`;
const OSC11_RESPONSE_TERMINATOR_PATTERN = `(?:${BEL}|${ESC}\\\\)`;
export const OSC11_RESPONSE = new RegExp(
  String.raw`${ESC}?\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})${OSC11_RESPONSE_TERMINATOR_PATTERN}`,
  "i",
);
export const OSC11_RESPONSE_PREFIX = `${ESC}]11;rgb:`;
export const OSC11_RESPONSE_PREFIX_NO_ESC = "]11;rgb:";

// Keep notification/title payloads bounded so terminal tabs and desktop
// notifications stay readable.
export const MAX_TERMINAL_NOTIFICATION_MESSAGE_LENGTH = 240;
export const MAX_TERMINAL_TITLE_LENGTH = 32;

// OSC 11 probing must be short because unsupported terminals do not reply.
export const TERMINAL_THEME_DETECT_TIMEOUT_MS = 250;
export const TERMINAL_THEME_INPUT_BUFFER_MAX_LENGTH = 512;
