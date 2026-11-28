import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Text, TuiAltScreen } from '@moonshot-ai/pi-tui';
import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  handleReloadCommand,
  handleReloadTuiCommand,
} from '#/tui/commands/reload';
import type { SlashCommandHost } from '#/tui/commands';
import {
  isExperimentalFlagEnabled,
  setExperimentalFeatures,
} from '#/tui/commands/experimental-flags';
import type { TuiMode } from '#/tui/config';
import { TUI_MODE_SWITCH_BLOCKED_NOTICE } from '#/tui/constant/kimi-tui';
import type { TuiModeSwitchResult } from '#/tui/tui-renderer';
import {
  createMarkdownOptions,
  getMarkdownMermaidMode,
  setMarkdownMermaidMode,
  setMarkdownRenderLatex,
} from '#/tui/utils/markdown-options';

const tempDirs: string[] = [];
const originalKimiCodeHome = process.env['KIMI_CODE_HOME'];

beforeEach(() => {
  vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '');
  vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '');
  vi.stubEnv('TERM', 'xterm-256color');
  vi.stubEnv('TERMUX_VERSION', '');
  vi.stubEnv('TMUX', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  setExperimentalFeatures([]);
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  if (originalKimiCodeHome === undefined) {
    delete process.env['KIMI_CODE_HOME'];
  } else {
    process.env['KIMI_CODE_HOME'] = originalKimiCodeHome;
  }
});

describe('reload slash commands', () => {
  it('reloads tui.toml without touching Core session state', async () => {
    await writeTuiConfig(`
theme = "light"
cache_expiry_hint = false

[editor]
command = "vim"

[notifications]
enabled = false
notification_condition = "always"

[upgrade]
auto_install = false
`);
    const session = { reloadSession: vi.fn() };
    const host = makeHost({ session });

    await handleReloadTuiCommand(host);

    expect(host.harness.getConfig).not.toHaveBeenCalled();
    expect(host.harness.getExperimentalFeatures).not.toHaveBeenCalled();
    expect(session.reloadSession).not.toHaveBeenCalled();
    expect(host.state.appState).toMatchObject({
      theme: 'light',
      editorCommand: 'vim',
      cacheExpiryHint: false,
      notifications: { enabled: false, condition: 'always' },
      upgrade: { autoInstall: false },
    });
    expect(host.showStatus).toHaveBeenCalledWith(
      'TUI config reloaded.',
      'success',
    );
  });

  it('reloads the active session, refreshes runtime config, and applies tui.toml', async () => {
    await writeTuiConfig('theme = "light"\n');
    const session = { id: 'ses-1', reloadSession: vi.fn(async () => ({})) };
    const host = makeHost({ session });

    await handleReloadCommand(host);

    expect(host.harness.reloadSession).toHaveBeenCalledWith({
      id: session.id,
      forcePluginSessionStartReminder: true,
    });
    expect(session.reloadSession).not.toHaveBeenCalled();
    expect(host.reloadCurrentSessionView).toHaveBeenCalledWith(
      session,
      'Session reloaded.',
    );
    expect(host.harness.getConfig).toHaveBeenCalledWith({ reload: true });
    expect(host.harness.getExperimentalFeatures).toHaveBeenCalledOnce();
    expect(host.refreshSlashCommandAutocomplete).toHaveBeenCalledOnce();
    expect(isExperimentalFlagEnabled('micro_compaction')).toBe(true);
    expect(host.state.appState.theme).toBe('light');
    expect(host.state.appState.availableModels).toEqual({
      fresh: { provider: 'test', model: 'fresh-model', maxContextSize: 1000 },
    });
  });

  it('awaits the async theme application before refreshing terminal tracking', async () => {
    await writeTuiConfig('theme = "auto"\n');
    const host = makeHost();
    const mutable = host as unknown as {
      applyTheme: (theme: string) => Promise<void>;
      refreshTerminalThemeTracking: () => void;
      state: { appState: { theme: string } };
    };

    let themeWhenTracked: string | undefined;
    mutable.applyTheme = vi.fn(async (theme: string) => {
      await Promise.resolve();
      mutable.state.appState.theme = theme;
    });
    mutable.refreshTerminalThemeTracking = vi.fn(() => {
      themeWhenTracked = mutable.state.appState.theme;
    });

    await handleReloadTuiCommand(host);

    expect(themeWhenTracked).toBe('auto');
  });

  it('applies the render_latex toggle before theme application rebuilds Markdown', async () => {
    await writeTuiConfig('render_latex = false\n');
    const host = makeHost();

    let latexWhenThemeApplied: boolean | undefined;
    const mutable = host as unknown as { applyTheme: unknown };
    mutable.applyTheme = vi.fn(() => {
      latexWhenThemeApplied = createMarkdownOptions().renderLatex;
    });

    try {
      await handleReloadTuiCommand(host);
      expect(latexWhenThemeApplied).toBe(false);
    } finally {
      setMarkdownRenderLatex(true);
    }
  });

  it('applies the mermaid mode before theme application rebuilds Markdown', async () => {
    await writeTuiConfig('[markdown]\nmermaid = "off"\n');
    const host = makeHost();

    let mermaidWhenThemeApplied: string | undefined;
    const mutable = host as unknown as { applyTheme: unknown };
    mutable.applyTheme = vi.fn(() => {
      mermaidWhenThemeApplied = getMarkdownMermaidMode();
    });

    try {
      await handleReloadTuiCommand(host);
      expect(mermaidWhenThemeApplied).toBe('off');
      expect(host.setAppState).toHaveBeenCalledWith(
        expect.objectContaining({ markdown: { mermaid: 'off' } }),
      );
    } finally {
      setMarkdownMermaidMode('final');
    }
  });

  it('refreshes workspace commands and lazy defaults on a session-less v2 reload', async () => {
    await writeTuiConfig('theme = "dark"\n');
    const host = makeHost();
    const refreshSkillCommands = vi.fn(async () => {});
    const refreshPluginCommands = vi.fn(async () => {});
    const hydrateLazyConfigDefaults = vi.fn(async () => {});
    Object.assign(host, {
      refreshSkillCommands,
      refreshPluginCommands,
      hydrateLazyConfigDefaults,
    });

    await handleReloadCommand(host);

    expect(refreshSkillCommands).toHaveBeenCalledOnce();
    expect(refreshPluginCommands).toHaveBeenCalledOnce();
    expect(hydrateLazyConfigDefaults).toHaveBeenCalledOnce();
    expect(refreshSkillCommands.mock.invocationCallOrder[0]).toBeLessThan(
      host.refreshSlashCommandAutocomplete.mock.invocationCallOrder[0]!,
    );
    expect(host.showStatus).toHaveBeenCalledWith(
      'Environment and TUI config reloaded; no active session.',
      'success',
    );
  });

  it('applies follow_up_behavior from tui.toml', async () => {
    await writeTuiConfig('follow_up_behavior = "steer"\n');
    const host = makeHost();

    await handleReloadTuiCommand(host);

    expect(host.state.appState.followUpBehavior).toBe('steer');
  });

  it('returns follow_up_behavior to unset when the key is removed from tui.toml', async () => {
    await writeTuiConfig('theme = "dark"\n');
    const host = makeHost();
    host.state.appState.followUpBehavior = 'steer';

    await handleReloadTuiCommand(host);

    expect(host.state.appState.followUpBehavior).toBeUndefined();
  });

  it('switches TUI mode live when tui_mode differs from the running UI mode', async () => {
    await writeTuiConfig('tui_mode = "fullscreen"\n');
    const host = makeHost();

    await handleReloadTuiCommand(host);

    expect(host.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ tuiMode: 'fullscreen' }),
    );
    expect(host.switchTuiMode).toHaveBeenCalledWith('fullscreen');
    expect(host.state.transcriptContainer.setPresentationOptions).not.toHaveBeenCalled();
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('shows the blocked notice and still updates transcript presentation when live switch is blocked', async () => {
    await writeTuiConfig('tui_mode = "fullscreen"\n');
    const host = makeHost({
      switchResult: { status: 'blocked', reason: 'active-overlay' },
    });

    await handleReloadTuiCommand(host);

    expect(host.switchTuiMode).toHaveBeenCalledWith('fullscreen');
    expect(host.state.transcriptContainer.setPresentationOptions).toHaveBeenCalledOnce();
    expect(host.showNotice).toHaveBeenCalledWith(TUI_MODE_SWITCH_BLOCKED_NOTICE);
  });

  it('shows the env override notice when KIMI_CODE_TUI_FULL_SCREEN overrides tui.toml', async () => {
    vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '0');
    await writeTuiConfig('tui_mode = "fullscreen"\n');
    const host = makeHost();

    await handleReloadTuiCommand(host);

    expect(host.switchTuiMode).not.toHaveBeenCalled();
    expect(host.state.transcriptContainer.setPresentationOptions).toHaveBeenCalledOnce();
    expect(host.showNotice).toHaveBeenCalledWith(
      'Unset KIMI_CODE_TUI_FULL_SCREEN for tui_mode in tui.toml to take effect.',
    );
  });

  it('shows the fallback notice when terminal fallback overrides tui.toml fullscreen', async () => {
    vi.stubEnv('TERM', 'dumb');
    await writeTuiConfig('tui_mode = "fullscreen"\n');
    const host = makeHost();

    await handleReloadTuiCommand(host);

    expect(host.switchTuiMode).not.toHaveBeenCalled();
    expect(host.state.transcriptContainer.setPresentationOptions).toHaveBeenCalledOnce();
    expect(host.showNotice).toHaveBeenCalledWith(
      'This terminal automatically falls back to regular mode unless KIMI_CODE_TUI_FULL_SCREEN=1 is set.',
    );
  });

  it('switches back to regular when tui_mode is removed from tui.toml while fullscreen is active', async () => {
    await writeTuiConfig('theme = "dark"\n');
    const host = makeHost({ runningMode: 'fullscreen' });

    await handleReloadTuiCommand(host);

    expect(host.switchTuiMode).toHaveBeenCalledWith('regular');
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('does not notice when tui_mode matches the running UI mode', async () => {
    await writeTuiConfig('theme = "dark"\n');
    const host = makeHost();

    await handleReloadTuiCommand(host);

    expect(host.switchTuiMode).toHaveBeenCalledWith('regular');
    expect(host.state.transcriptContainer.setPresentationOptions).toHaveBeenCalledOnce();
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('does not notice when tui_mode is unset and experimental flag keeps fullscreen active', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '1');
    await writeTuiConfig('theme = "dark"\n');
    const host = makeHost({ runningMode: 'fullscreen' });

    await handleReloadTuiCommand(host);

    expect(host.switchTuiMode).toHaveBeenCalledWith('fullscreen');
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  async function attachFullscreenRenderer(host: ReturnType<typeof makeHost>) {
    const vt = new VirtualTerminal(40, 12);
    const ui = new TuiAltScreen(vt, undefined, undefined, { wheelScrollLines: 'auto' });
    ui.addChild(
      new Text(Array.from({ length: 60 }, (_, index) => `line ${String(index + 1)}`).join('\n'), 0, 0),
    );
    ui.start();
    onTestFinished(() => {
      ui.stop();
    });
    await vt.waitForRender();
    Object.assign(host.state, { ui });
    return { ui, vt };
  }

  it('hot-reloads wheel_scroll_lines on /reload-tui and updates live TuiAltScreen scrolling', async () => {
    await writeTuiConfig('tui_mode = "fullscreen"\nwheel_scroll_lines = 4\n');
    const host = makeHost();
    const { ui, vt } = await attachFullscreenRenderer(host);

    await handleReloadTuiCommand(host);

    expect(host.state.appState.wheelScrollLines).toBe(4);
    const before = ui.viewportTop;
    vt.sendInput('\u001B[<64;1;1M');
    await vt.waitForRender();
    expect(before - ui.viewportTop).toBe(4);
  });

  it('hot-reloads wheel_scroll_lines on /reload and updates live TuiAltScreen scrolling', async () => {
    await writeTuiConfig('tui_mode = "fullscreen"\nwheel_scroll_lines = 5\n');
    const session = { id: 'ses-1', reloadSession: vi.fn(async () => ({})) };
    const host = makeHost({ session });
    const { ui, vt } = await attachFullscreenRenderer(host);

    await handleReloadCommand(host);

    expect(host.state.appState.wheelScrollLines).toBe(5);
    const before = ui.viewportTop;
    vt.sendInput('\u001B[<64;1;1M');
    await vt.waitForRender();
    expect(before - ui.viewportTop).toBe(5);
  });

  it('reverts live TuiAltScreen wheel scrolling to auto when wheel_scroll_lines is removed on /reload-tui', async () => {
    vi.stubEnv('SSH_CONNECTION', '1');
    let now = 1_000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    onTestFinished(() => {
      nowSpy.mockRestore();
    });

    await writeTuiConfig('tui_mode = "fullscreen"\nwheel_scroll_lines = 4\n');
    const host = makeHost();
    const { ui, vt } = await attachFullscreenRenderer(host);
    await handleReloadTuiCommand(host);
    expect(host.state.appState.wheelScrollLines).toBe(4);

    await writeTuiConfig('tui_mode = "fullscreen"\n');
    await handleReloadTuiCommand(host);

    expect(host.state.appState.wheelScrollLines).toBeUndefined();
    const start = ui.viewportTop;
    vt.sendInput('\u001B[<64;1;1M');
    await vt.waitForRender();
    const afterFirst = ui.viewportTop;
    expect(start - afterFirst).toBe(1);

    now += 25;
    vt.sendInput('\u001B[<64;1;1M');
    await vt.waitForRender();
    expect(afterFirst - ui.viewportTop).toBeGreaterThan(1);
  });

  it('warns and falls back to auto when wheel_scroll_lines is invalid on /reload-tui', async () => {
    vi.stubEnv('SSH_CONNECTION', '1');
    let now = 2_000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    onTestFinished(() => {
      nowSpy.mockRestore();
    });

    await writeTuiConfig('tui_mode = "fullscreen"\nwheel_scroll_lines = 4\n');
    const host = makeHost();
    const { ui, vt } = await attachFullscreenRenderer(host);
    await handleReloadTuiCommand(host);

    await writeTuiConfig('tui_mode = "fullscreen"\nwheel_scroll_lines = "3"\n');
    await handleReloadTuiCommand(host);

    expect(host.state.appState.wheelScrollLines).toBeUndefined();
    expect(host.showStatus).toHaveBeenCalledWith(
      '[tui.toml] ignoring invalid wheel_scroll_lines value: "3" (expected "auto" or a positive integer)',
      'warning',
    );
    const start = ui.viewportTop;
    vt.sendInput('\u001B[<64;1;1M');
    await vt.waitForRender();
    const afterFirst = ui.viewportTop;
    expect(start - afterFirst).toBe(1);

    now += 25;
    vt.sendInput('\u001B[<64;1;1M');
    await vt.waitForRender();
    expect(afterFirst - ui.viewportTop).toBeGreaterThan(1);
  });
});

async function writeTuiConfig(text: string): Promise<void> {
  const dir = join(tmpdir(), `kimi-tui-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  process.env['KIMI_CODE_HOME'] = dir;
  await writeFile(join(dir, 'tui.toml'), text, 'utf-8');
}

function makeHost({
  session,
  runningMode = 'regular',
  switchResult,
}: {
  readonly session?: Record<string, unknown>;
  readonly runningMode?: TuiMode;
  readonly switchResult?: TuiModeSwitchResult;
} = {}) {
  const ui: { mode: TuiMode } = { mode: runningMode };
  const state = {
    appState: {
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      availableModels: {},
      availableProviders: {},
      transcript: { toolCallDensity: 'compact', thinking: 'grouped' },
    },
    transcriptContainer: { setPresentationOptions: vi.fn() },
    editor: {
      setDisablePasteBurst: vi.fn(),
    },
    ui,
    theme: {
      palette: {
        success: '#00ff00',
      },
    },
  };
  return {
    state,
    session,
    harness: {
      reloadSession: vi.fn(async () => session),
      getConfig: vi.fn(async () => ({
        models: {
          fresh: { provider: 'test', model: 'fresh-model', maxContextSize: 1000 },
        },
        providers: {
          test: { type: 'kimi', apiKey: 'test-key' },
        },
      })),
      getExperimentalFeatures: vi.fn(async () => [{ id: 'micro_compaction', enabled: true }]),
    },
    setAppState: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(state.appState, patch);
    }),
    applyTheme: vi.fn((theme: string) => {
      state.appState.theme = theme;
    }),
    refreshTerminalThemeTracking: vi.fn(),
    refreshSlashCommandAutocomplete: vi.fn(),
    reloadCurrentSessionView: vi.fn(async () => {}),
    switchTuiMode: vi.fn((mode: TuiMode): TuiModeSwitchResult => {
      if (switchResult !== undefined) return switchResult;
      if (mode === state.ui.mode) return { status: 'unchanged', mode };
      const from = state.ui.mode;
      (state.ui as { mode: TuiMode }).mode = mode;
      return { status: 'switched', from, to: mode };
    }),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
  } as unknown as SlashCommandHost & {
    readonly harness: {
      readonly reloadSession: ReturnType<typeof vi.fn>;
      readonly getConfig: ReturnType<typeof vi.fn>;
      readonly getExperimentalFeatures: ReturnType<typeof vi.fn>;
    };
    readonly refreshSlashCommandAutocomplete: ReturnType<typeof vi.fn>;
    readonly reloadCurrentSessionView: ReturnType<typeof vi.fn>;
    readonly switchTuiMode: ReturnType<typeof vi.fn>;
    readonly showStatus: ReturnType<typeof vi.fn>;
    readonly showNotice: ReturnType<typeof vi.fn>;
  };
}
