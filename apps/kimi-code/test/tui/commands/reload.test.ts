import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  handleReloadCommand,
  handleReloadTuiCommand,
} from '#/tui/commands/reload';
import { currentTheme } from '#/tui/theme';
import type { SlashCommandHost } from '#/tui/commands';
import {
  isExperimentalFlagEnabled,
  setExperimentalFeatures,
} from '#/tui/commands/experimental-flags';

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
  it('reloads tui.toml without touching Core session state', async () => {
    await writeTuiConfig(`
theme = "light"

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
