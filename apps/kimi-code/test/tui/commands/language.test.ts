import { describe, expect, it, vi } from 'vitest';

import { applyLanguageChoice } from '#/tui/commands/config';
import { i18n } from '#/tui/i18n';
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

function makeHost() {
  const requestRender = vi.fn();
  const setAppState = vi.fn();
  const showStatus = vi.fn();
  const track = vi.fn();
  const refreshSlashCommandAutocomplete = vi.fn();
  const host = {
    state: {
      appState: {
        theme: 'auto' as const,
        language: 'auto' as const,
        editorCommand: null,
        notifications: { enabled: true, condition: 'unfocused' as const },
        upgrade: { autoInstall: true },
      },
      theme: { palette: darkColors },
      ui: { requestRender },
    },
    setAppState,
    showStatus,
    track,
    refreshSlashCommandAutocomplete,
  };
  return { host, requestRender, setAppState, showStatus, track, refreshSlashCommandAutocomplete };
}

describe('language commands', () => {
  it('persists, switches runtime locale, and re-renders when the language changes', async () => {
    mocks.saveTuiConfig.mockClear();
    const setLocale = vi.spyOn(i18n, 'setLocale');
    const { host, requestRender, setAppState, refreshSlashCommandAutocomplete } = makeHost();

    await applyLanguageChoice(host, 'zh-CN');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith({
      theme: 'auto',
      language: 'zh-CN',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
    });
    expect(setAppState).toHaveBeenCalledWith({ language: 'zh-CN' });
    expect(setLocale).toHaveBeenCalledWith('zh-CN');
    expect(requestRender).toHaveBeenCalled();
    // The slash-command autocomplete holds a snapshot of localized descriptions
    // built once via setupAutocomplete(); flipping the locale must rebuild it so
    // the `/` menu follows the new language without a restart.
    expect(refreshSlashCommandAutocomplete).toHaveBeenCalled();

    setLocale.mockRestore();
  });
});
