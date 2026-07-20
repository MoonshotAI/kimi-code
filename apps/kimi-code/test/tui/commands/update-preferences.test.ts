import { describe, expect, it, vi } from 'vitest';

import { applyUpdatePreferenceChoice } from '#/tui/commands/config';
import { darkColors } from '#/tui/theme/colors';

const mocks = vi.hoisted(() => ({
  saveTuiConfig: vi.fn(),
  t: (key: string, params?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      'tui.dialogs.config.configAutoUpdateSet': `Automatic updates ${String(params?.state ?? '')}.`,
      'tui.dialogs.config.configAutoUpdateAlready': `Automatic updates already ${String(params?.state ?? '')}.`,
      'tui.dialogs.config.configAutoUpdateSaveFailed': 'Failed to save automatic update setting: {{error}}',
      'tui.dialogs.config.configAutoUpdateEnabled': 'enabled',
      'tui.dialogs.config.configAutoUpdateDisabled': 'disabled',
      'tui.dialogs.config.configPermissionUnchanged': 'Permission mode unchanged: {{mode}}.',
      'tui.dialogs.config.configPermissionMode': 'Permission mode: {{mode}}',
    };
    return translations[key] ?? key;
  },
}));

vi.mock('#/i18n', () => ({
  t: mocks.t,
  setLocale: vi.fn(),
  getLocale: () => 'en',
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
        },
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
      disablePasteBurst: false,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: false },
    });
    expect(setAppState).toHaveBeenCalledWith({ upgrade: { autoInstall: false } });
    expect(track).toHaveBeenCalledWith('upgrade_preference_changed', { auto_install: false });
    expect(showStatus).toHaveBeenCalledWith('Automatic updates disabled.');
  });
});
