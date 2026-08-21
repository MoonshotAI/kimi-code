import chalk from "chalk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TUIState } from "#/tui/kimi-tui";
import {
  basicDarkColors,
  basicLightColors,
  darkColors,
  lightColors,
} from "#/tui/theme/colors";
import {
  getBuiltInPalette,
  getBuiltInPaletteForTerminal,
  getColorPaletteSync,
  inferBuiltInResolvedTheme,
  isBasicColorTerminal,
} from "#/tui/theme";
import {
  DISABLE_TERMINAL_THEME_REPORTING,
  ENABLE_TERMINAL_THEME_REPORTING,
  OSC11_QUERY,
  QUERY_TERMINAL_THEME,
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_LIGHT,
  createTerminalThemeInputState,
  hasTerminalThemeReport,
  handleTerminalThemeInput,
  installTerminalThemeTracking,
} from "#/tui/utils/terminal-theme";

type InputListener = Parameters<TUIState["ui"]["addInputListener"]>[0];
const DARK_OSC11_REPORT = "\u001B]11;rgb:2828/2c2c/3434\u0007";
const LIGHT_OSC11_REPORT = "\u001B]11;rgb:fafa/fbfb/fcfc\u0007";

describe("terminal theme tracking", () => {
  it("recognizes terminal theme reports as change notifications", () => {
    expect(hasTerminalThemeReport(TERMINAL_THEME_DARK)).toBe(true);
    expect(hasTerminalThemeReport(TERMINAL_THEME_LIGHT)).toBe(true);
    expect(hasTerminalThemeReport(`x${TERMINAL_THEME_LIGHT}y`)).toBe(true);
    expect(hasTerminalThemeReport("x")).toBe(false);
  });

  it("consumes theme reports by querying the terminal background", () => {
    const terminal = { write: vi.fn() };
    const onTheme = vi.fn();

    expect(handleTerminalThemeInput(TERMINAL_THEME_DARK, terminal, onTheme)).toEqual({
      consume: true,
    });
    expect(handleTerminalThemeInput(TERMINAL_THEME_LIGHT, terminal, onTheme)).toEqual({
      consume: true,
    });

    expect(terminal.write).toHaveBeenCalledTimes(2);
    expect(terminal.write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(onTheme).not.toHaveBeenCalled();
  });

  it("strips terminal theme reports without dropping coalesced input", () => {
    const terminal = { write: vi.fn() };
    const onTheme = vi.fn();

    expect(handleTerminalThemeInput(`a${TERMINAL_THEME_LIGHT}b`, terminal, onTheme)).toEqual({
      data: "ab",
    });

    expect(terminal.write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(onTheme).not.toHaveBeenCalled();
  });

  it("consumes OSC 11 background reports and forwards resolved themes", () => {
    const terminal = { write: vi.fn() };
    const onTheme = vi.fn();

    expect(handleTerminalThemeInput(DARK_OSC11_REPORT, terminal, onTheme)).toEqual({
      consume: true,
    });
    expect(onTheme).toHaveBeenLastCalledWith("dark");

    expect(handleTerminalThemeInput(LIGHT_OSC11_REPORT, terminal, onTheme)).toEqual({
      consume: true,
    });
    expect(onTheme).toHaveBeenLastCalledWith("light");

    expect(handleTerminalThemeInput("x", terminal, onTheme)).toBeUndefined();
    expect(handleTerminalThemeInput("]", terminal, onTheme)).toBeUndefined();
    expect(onTheme).toHaveBeenCalledTimes(2);
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it("strips OSC 11 background reports without dropping coalesced input", () => {
    const terminal = { write: vi.fn() };
    const onTheme = vi.fn();

    expect(handleTerminalThemeInput(`a${DARK_OSC11_REPORT}b`, terminal, onTheme)).toEqual({
      data: "ab",
    });

    expect(onTheme).toHaveBeenCalledWith("dark");
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it("accumulates fragmented OSC 11 background reports", () => {
    const terminal = { write: vi.fn() };
    const onTheme = vi.fn();
    const inputState = createTerminalThemeInputState();

    expect(
      handleTerminalThemeInput("\u001B]11;rgb:2828/2c2c/3", terminal, onTheme, inputState),
    ).toEqual({ consume: true });
    expect(onTheme).not.toHaveBeenCalled();

    expect(handleTerminalThemeInput("434\u0007", terminal, onTheme, inputState)).toEqual({
      consume: true,
    });
    expect(onTheme).toHaveBeenCalledWith("dark");
    expect(inputState.osc11Buffer).toBe("");
  });

  it("forwards input that follows a fragmented OSC 11 background report", () => {
    const terminal = { write: vi.fn() };
    const onTheme = vi.fn();
    const inputState = createTerminalThemeInputState();

    expect(
      handleTerminalThemeInput("\u001B]11;rgb:2828/2c2c/3", terminal, onTheme, inputState),
    ).toEqual({ consume: true });

    expect(handleTerminalThemeInput("434\u0007x", terminal, onTheme, inputState)).toEqual({
      data: "x",
    });
    expect(onTheme).toHaveBeenCalledWith("dark");
    expect(inputState.osc11Buffer).toBe("");
  });

  it("enables reporting, queries current theme, and disables on dispose", () => {
    const listeners: InputListener[] = [];
    const removeInputListener = vi.fn();
    const onTheme = vi.fn();
    const state = {
      terminal: {
        write: vi.fn(),
      },
      ui: {
        addInputListener: vi.fn((listener: InputListener) => {
          listeners.push(listener);
          return removeInputListener;
        }),
      },
    } as unknown as Pick<TUIState, "terminal" | "ui">;

    const dispose = installTerminalThemeTracking(state, onTheme);

    expect(state.terminal.write).toHaveBeenCalledWith(ENABLE_TERMINAL_THEME_REPORTING);
    expect(state.terminal.write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(state.terminal.write).toHaveBeenCalledWith(QUERY_TERMINAL_THEME);
    expect(listeners).toHaveLength(1);

    expect(listeners[0]?.(TERMINAL_THEME_LIGHT)).toEqual({ consume: true });
    expect(state.terminal.write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(onTheme).not.toHaveBeenCalled();

    expect(listeners[0]?.("\u001B]11;rgb:2828/2c2c/3")).toEqual({ consume: true });
    expect(onTheme).not.toHaveBeenCalled();

    expect(listeners[0]?.("434\u0007")).toEqual({ consume: true });
    expect(onTheme).toHaveBeenCalledWith("dark");

    dispose();

    expect(removeInputListener).toHaveBeenCalledOnce();
    expect(state.terminal.write).toHaveBeenCalledWith(DISABLE_TERMINAL_THEME_REPORTING);
  });
});

describe('ColorPalette warning token', () => {
  it('has a defined warning color in both themes', () => {
    expect(darkColors.warning).toBeTruthy();
    expect(lightColors.warning).toBeTruthy();
    expect(darkColors.warning).not.toBe(lightColors.warning);
  });

  it('resolves the correct palette by theme name', () => {
    expect(getBuiltInPalette('dark')).toBe(darkColors);
    expect(getBuiltInPalette('light')).toBe(lightColors);
  });
});

describe('ANSI-16 basic palette fallback', () => {
  const originalLevel = chalk.level;

  afterEach(() => {
    chalk.level = originalLevel;
  });

  const sgrCode = (hex: string): string => {
    const match = /\u001B\[(\d+)m/.exec(chalk.hex(hex)("X"));
    if (match === null) throw new Error(`chalk emitted no SGR code for ${hex}`);
    return match[1]!;
  };

  it('detects basic-color terminals from chalk level 1 only', () => {
    chalk.level = 1;
    expect(isBasicColorTerminal()).toBe(true);
    chalk.level = 0;
    expect(isBasicColorTerminal()).toBe(false);
    chalk.level = 2;
    expect(isBasicColorTerminal()).toBe(false);
    chalk.level = 3;
    expect(isBasicColorTerminal()).toBe(false);
  });

  it('swaps built-in palettes for the basic variants at level 1', () => {
    chalk.level = 1;
    expect(getBuiltInPaletteForTerminal("dark")).toBe(basicDarkColors);
    expect(getBuiltInPaletteForTerminal("light")).toBe(basicLightColors);
    expect(getColorPaletteSync("dark")).toBe(basicDarkColors);
    chalk.level = 3;
    expect(getBuiltInPaletteForTerminal("dark")).toBe(darkColors);
    expect(getBuiltInPaletteForTerminal("light")).toBe(lightColors);
    expect(getColorPaletteSync("dark")).toBe(darkColors);
  });

  it('keeps every basic dark token off black (SGR 30) at level 1', () => {
    chalk.level = 1;
    for (const [token, hex] of Object.entries(basicDarkColors)) {
      expect(sgrCode(hex), `basicDarkColors.${token}`).not.toBe("30");
    }
  });

  it('keeps every basic light token off white (SGR 37/97) at level 1', () => {
    chalk.level = 1;
    for (const [token, hex] of Object.entries(basicLightColors)) {
      expect(sgrCode(hex), `basicLightColors.${token}`).not.toBe("37");
      expect(sgrCode(hex), `basicLightColors.${token}`).not.toBe("97");
    }
  });

  it('infers the resolved theme from built-in and basic palette identities', () => {
    expect(inferBuiltInResolvedTheme(darkColors)).toBe("dark");
    expect(inferBuiltInResolvedTheme(basicDarkColors)).toBe("dark");
    expect(inferBuiltInResolvedTheme(lightColors)).toBe("light");
    expect(inferBuiltInResolvedTheme(basicLightColors)).toBe("light");
    // Custom-theme palettes are new objects and must not be inferred.
    expect(inferBuiltInResolvedTheme({ ...lightColors })).toBeNull();
  });

  it('keeps basic dark hues on their intended ANSI codes', () => {
    chalk.level = 1;
    expect(sgrCode(basicDarkColors.primary)).toBe("94");
    expect(sgrCode(basicDarkColors.diffAddedStrong)).toBe("92");
    expect(sgrCode(basicDarkColors.diffRemovedStrong)).toBe("91");
    expect(sgrCode(basicDarkColors.shellMode)).toBe("95");
    expect(sgrCode(basicDarkColors.warning)).toBe("93");
  });

  it('keeps basic light hues on their intended ANSI codes', () => {
    chalk.level = 1;
    expect(sgrCode(basicLightColors.success)).toBe("32");
    expect(sgrCode(basicLightColors.diffAdded)).toBe("32");
    expect(sgrCode(basicLightColors.warning)).toBe("33");
    expect(sgrCode(basicLightColors.roleUser)).toBe("33");
    expect(sgrCode(basicLightColors.shellMode)).toBe("35");
    expect(sgrCode(basicLightColors.error)).toBe("31");
  });
});
