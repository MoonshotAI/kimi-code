import {
  DISABLE_TERMINAL_THEME_REPORTING,
  ENABLE_TERMINAL_THEME_REPORTING,
  OSC11_QUERY,
  OSC11_RESPONSE,
  OSC11_RESPONSE_PREFIX,
  OSC11_RESPONSE_PREFIX_NO_ESC,
  QUERY_TERMINAL_THEME,
  TERMINAL_THEME_INPUT_BUFFER_MAX_LENGTH,
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_LIGHT,
} from "#/tui/constant/terminal";
import type { TUIState } from "#/tui/tui-state";
import type { ResolvedTheme } from "#/tui/theme/colors";
import { parseOsc11BackgroundTheme } from "#/tui/theme/terminal-background";

export {
  DISABLE_TERMINAL_THEME_REPORTING,
  ENABLE_TERMINAL_THEME_REPORTING,
  OSC11_QUERY,
  QUERY_TERMINAL_THEME,
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_LIGHT,
} from "#/tui/constant/terminal";

export function hasTerminalThemeReport(data: string): boolean {
  return data.includes(TERMINAL_THEME_DARK) || data.includes(TERMINAL_THEME_LIGHT);
}

export interface TerminalThemeInputState {
  osc11Buffer: string;
}

export type TerminalThemeInputResult =
  | {
      consume?: boolean;
      data?: string;
    }
  | undefined;

export function createTerminalThemeInputState(): TerminalThemeInputState {
  return { osc11Buffer: "" };
}

export function handleTerminalThemeInput(
  data: string,
  terminal: Pick<TUIState["terminal"], "write">,
  onTheme: (theme: ResolvedTheme) => void,
  inputState: TerminalThemeInputState = createTerminalThemeInputState(),
): TerminalThemeInputResult {
  let remaining = data;

  if (inputState.osc11Buffer !== "") {
    const candidate = `${inputState.osc11Buffer}${data}`;
    const stripped = stripOsc11Reports(candidate, onTheme);
    if (stripped !== candidate) {
      inputState.osc11Buffer = "";
      return resultFromRemaining(stripped);
    }

    inputState.osc11Buffer =
      candidate.length > TERMINAL_THEME_INPUT_BUFFER_MAX_LENGTH ? "" : candidate;
    return { consume: true };
  }

  remaining = stripOsc11Reports(remaining, onTheme);
  remaining = stripTerminalThemeReports(remaining, terminal);

  const partialOsc11Start = findPartialOsc11Start(remaining);
  if (partialOsc11Start !== -1) {
    inputState.osc11Buffer = remaining.slice(partialOsc11Start);
    return resultFromRemaining(remaining.slice(0, partialOsc11Start));
  }

  if (remaining !== data) return resultFromRemaining(remaining);

  return undefined;
}

function stripOsc11Reports(data: string, onTheme: (theme: ResolvedTheme) => void): string {
  let remaining = data;

  for (;;) {
    const match = OSC11_RESPONSE.exec(remaining);
    if (match === null) return remaining;

    const theme = parseOsc11BackgroundTheme(match[0]);
    if (theme !== null) onTheme(theme);

    remaining = `${remaining.slice(0, match.index)}${remaining.slice(match.index + match[0].length)}`;
  }
}

function stripTerminalThemeReports(
  data: string,
  terminal: Pick<TUIState["terminal"], "write">,
): string {
  let remaining = data;
  let strippedReport = false;

  for (const report of [TERMINAL_THEME_DARK, TERMINAL_THEME_LIGHT]) {
    if (!remaining.includes(report)) continue;
    remaining = remaining.split(report).join("");
    strippedReport = true;
  }

  if (strippedReport) {
    terminal.write(OSC11_QUERY);
  }

  return remaining;
}

function findPartialOsc11Start(data: string): number {
  const fullPrefixIndex = data.indexOf(OSC11_RESPONSE_PREFIX);
  if (fullPrefixIndex !== -1) return fullPrefixIndex;

  const noEscPrefixIndex = data.indexOf(OSC11_RESPONSE_PREFIX_NO_ESC);
  if (noEscPrefixIndex !== -1) return noEscPrefixIndex;

  for (let i = 0; i < data.length; i++) {
    const suffix = data.slice(i);
    if (OSC11_RESPONSE_PREFIX.startsWith(suffix) && suffix.length > 1) return i;
    if (OSC11_RESPONSE_PREFIX_NO_ESC.startsWith(suffix) && suffix.startsWith("]11;")) {
      return i;
    }
  }

  return -1;
}

function resultFromRemaining(data: string): TerminalThemeInputResult {
  if (data.length === 0) return { consume: true };
  return { data };
}

export function installTerminalThemeTracking(
  state: Pick<TUIState, "terminal" | "ui">,
  onTheme: (theme: ResolvedTheme) => void,
): () => void {
  const inputState = createTerminalThemeInputState();
  const disposeInputListener = state.ui.addInputListener((data) =>
    handleTerminalThemeInput(data, state.terminal, onTheme, inputState),
  );
  state.terminal.write(ENABLE_TERMINAL_THEME_REPORTING);
  state.terminal.write(OSC11_QUERY);
  state.terminal.write(QUERY_TERMINAL_THEME);

  return () => {
    disposeInputListener();
    state.terminal.write(DISABLE_TERMINAL_THEME_REPORTING);
  };
}
