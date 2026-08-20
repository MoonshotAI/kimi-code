import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Container } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  handleReloadCommand,
  handleReloadTuiCommand,
} from '#/tui/commands/reload';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { currentTheme } from '#/tui/theme';
import type { SlashCommandHost } from '#/tui/commands';
import {
  isExperimentalFlagEnabled,
  setExperimentalFeatures,
} from '#/tui/commands/experimental-flags';
import {
  createMarkdownOptions,
  setMarkdownRenderLatex,
} from '#/tui/utils/markdown-options';

const tempDirs: string[] = [];
const originalKimiCodeHome = process.env['KIMI_CODE_HOME'];

afterEach(async () => {
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
  it('re-renders mounted transcript timestamps when the preference is reloaded', async () => {
    await writeTuiConfig('show_timestamp = false\n');
    const host = makeHost();
    const startedAt = new Date(2000, 0, 2, 10, 0, 0).getTime();
    const user = new UserMessageComponent('existing user message', [], undefined, startedAt);
    const assistant = new AssistantMessageComponent(true, startedAt, startedAt + 5_000);
    assistant.updateContent('existing assistant message');
    host.state.transcriptContainer.addChild(user);
    host.state.transcriptContainer.addChild(assistant);

    expect(stripSgr(host.state.transcriptContainer.render(120).join('\n'))).toContain(
      '2000-01-02 10:00:00',
    );

    await handleReloadTuiCommand(host);

    const transcript = stripSgr(host.state.transcriptContainer.render(120).join('\n'));
    expect(transcript).not.toContain('2000-01-02 10:00:00');
    expect(transcript).not.toContain('(took 5s)');
    expect(transcript).toContain('existing user message');
    expect(transcript).toContain('existing assistant message');

    await writeTuiConfig('show_timestamp = true\n');
    await handleReloadTuiCommand(host);

    const restored = stripSgr(host.state.transcriptContainer.render(120).join('\n'));
    expect(restored).toContain('2000-01-02 10:00:00');
    expect(restored).toContain('(took 5s)');
  });

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

    expect(session.reloadSession).toHaveBeenCalledWith({
      forcePluginSessionStartReminder: true,
    });
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
    // Theme application resolves on a later microtask, mirroring the real
    // async palette load; tracking must observe the *new* theme.
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

    // applyTheme invalidates transcript components, which rebuild their
    // Markdown children by copying the shared options — the reloaded value
    // must already be live at that point.
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

  it('refreshes workspace commands and lazy defaults on a session-less v2 reload', async () => {
    await writeTuiConfig('theme = "dark"\n');
    const host = makeHost();
    const refreshSkillCommands = vi.fn(async () => {});
    const refreshPluginCommands = vi.fn(async () => {});
    const hydrateLazyConfigDefaults = vi.fn(async () => {});
    Object.assign(host, {
      engineV2: true,
      refreshSkillCommands,
      refreshPluginCommands,
      hydrateLazyConfigDefaults,
    });

    await handleReloadCommand(host);

    expect(refreshSkillCommands).toHaveBeenCalledOnce();
    expect(refreshPluginCommands).toHaveBeenCalledOnce();
    expect(hydrateLazyConfigDefaults).toHaveBeenCalledOnce();
    // Autocomplete must rebuild after the command maps are refreshed.
    expect(refreshSkillCommands.mock.invocationCallOrder[0]).toBeLessThan(
      host.refreshSlashCommandAutocomplete.mock.invocationCallOrder[0]!,
    );
    expect(host.showStatus).toHaveBeenCalledWith(
      'Runtime and TUI config reloaded; no active session.',
      'success',
    );
  });
});

async function writeTuiConfig(text: string): Promise<void> {
  const dir = join(tmpdir(), `kimi-tui-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  process.env['KIMI_CODE_HOME'] = dir;
  await writeFile(join(dir, 'tui.toml'), text, 'utf-8');
}

function stripSgr(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makeHost({
  session,
}: {
  readonly session?: Record<string, unknown>;
} = {}) {
  const state = {
    appState: {
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      availableModels: {},
      availableProviders: {},
    },
    editor: {
      setDisablePasteBurst: vi.fn(),
    },
    transcriptContainer: new Container(),
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
    showStatus: vi.fn(),
  } as unknown as SlashCommandHost & {
    readonly harness: {
      readonly getConfig: ReturnType<typeof vi.fn>;
      readonly getExperimentalFeatures: ReturnType<typeof vi.fn>;
    };
    readonly refreshSlashCommandAutocomplete: ReturnType<typeof vi.fn>;
    readonly reloadCurrentSessionView: ReturnType<typeof vi.fn>;
    readonly showStatus: ReturnType<typeof vi.fn>;
  };
}
