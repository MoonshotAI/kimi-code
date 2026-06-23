import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyHardwareCursorChoice,
  applyUpdatePreferenceChoice,
} from '#/tui/commands/config';
import { darkColors } from '#/tui/theme/colors';

const mocks = vi.hoisted(() => ({
  saveTuiConfig: vi.fn(),
}));

vi.mock('../../../src/tui/config', async () => {
  const actual = await vi.importActual<typeof import('../../../src/tui/config.js')>(
    '../../../src/tui/config.js',
  );
  return {
    ...actual,
    saveTuiConfig: mocks.saveTuiConfig,
  };
});

describe('update preference commands', () => {
  beforeEach(() => {
    mocks.saveTuiConfig.mockClear();
  });

  it('saves automatic update preference changes to tui.toml', async () => {
    const setAppState = vi.fn();
    const showStatus = vi.fn();
    const track = vi.fn();
    const host = {
      state: {
        appState: {
          theme: 'auto' as const,
          editorCommand: null,
          notifications: { enabled: true, condition: 'unfocused' as const },
          upgrade: { autoInstall: true },
          terminal: { showHardwareCursor: false },
        },
        ui: { setShowHardwareCursor: vi.fn() },
        theme: { palette: darkColors },
      },
      setAppState,
      showStatus,
      track,
    };

    await applyUpdatePreferenceChoice(host, false);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith({
      theme: 'auto',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: false },
      terminal: { showHardwareCursor: false },
    });
    expect(setAppState).toHaveBeenCalledWith({ upgrade: { autoInstall: false } });
    expect(track).toHaveBeenCalledWith('upgrade_preference_changed', { auto_install: false });
    expect(showStatus).toHaveBeenCalledWith('Automatic updates disabled.');
  });

  it('saves hardware cursor preference changes and applies them immediately', async () => {
    const setAppState = vi.fn();
    const showStatus = vi.fn();
    const track = vi.fn();
    const setShowHardwareCursor = vi.fn();
    const host = {
      state: {
        appState: {
          theme: 'auto' as const,
          editorCommand: null,
          notifications: { enabled: true, condition: 'unfocused' as const },
          upgrade: { autoInstall: true },
          terminal: { showHardwareCursor: false },
        },
        ui: { setShowHardwareCursor },
        theme: { palette: darkColors },
      },
      setAppState,
      showStatus,
      track,
    };

    await applyHardwareCursorChoice(host, true);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith({
      theme: 'auto',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      terminal: { showHardwareCursor: true },
    });
    expect(setShowHardwareCursor).toHaveBeenCalledWith(true);
    expect(setAppState).toHaveBeenCalledWith({ terminal: { showHardwareCursor: true } });
    expect(track).toHaveBeenCalledWith('hardware_cursor_preference_changed', {
      show_hardware_cursor: true,
    });
    expect(showStatus).toHaveBeenCalledWith('Hardware cursor enabled.');
  });
});
