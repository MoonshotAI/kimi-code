import { BEL, ESC, ST } from "#/constant/terminal";

export { BEL, ESC, ST } from "#/constant/terminal";

export const QUERY_TERMINAL_THEME = `${ESC}[?996n`;
export const TERMINAL_THEME_DARK = `${ESC}[?997;1n`;
export const TERMINAL_THEME_LIGHT = `${ESC}[?997;2n`;
export const ENABLE_TERMINAL_THEME_REPORTING = `${ESC}[?2031h`;
export const DISABLE_TERMINAL_THEME_REPORTING = `${ESC}[?2031l`;

export const TERMINAL_FOCUS_IN = `${ESC}[I`;
export const TERMINAL_FOCUS_OUT = `${ESC}[O`;
export const ENABLE_TERMINAL_FOCUS_REPORTING = `${ESC}[?1004h`;
export const DISABLE_TERMINAL_FOCUS_REPORTING = `${ESC}[?1004l`;

export const CLICK_GUARD_MS = 300;

export const SGR_FAINT = `${ESC}[2m`;
export const SGR_NORMAL_INTENSITY = `${ESC}[22m`;
export const SGR_SEQUENCE = new RegExp(String.raw`${ESC}\[([0-9;:]*)m`, "g");

export const OSC11_QUERY = `${ESC}]11;?${BEL}`;
const OSC11_RESPONSE_TERMINATOR_PATTERN = `(?:${BEL}|${ESC}\\\\)`;
export const OSC11_RESPONSE = new RegExp(
  String.raw`${ESC}?\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})${OSC11_RESPONSE_TERMINATOR_PATTERN}`,
  "i",
);
export const OSC11_RESPONSE_PREFIX = `${ESC}]11;rgb:`;
export const OSC11_RESPONSE_PREFIX_NO_ESC = "]11;rgb:";

export const MAX_TERMINAL_NOTIFICATION_MESSAGE_LENGTH = 240;
export const MAX_TERMINAL_TITLE_LENGTH = 32;

export const TERMINAL_THEME_DETECT_TIMEOUT_MS = 250;
export const TERMINAL_THEME_INPUT_BUFFER_MAX_LENGTH = 512;
