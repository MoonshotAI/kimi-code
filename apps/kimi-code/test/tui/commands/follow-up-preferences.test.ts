import { describe, expect, it, vi } from 'vitest';

import { applyTuiModeChoice } from '#/tui/commands/config';

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

describe('follow-up behavior preference', () => {
  it('survives a save of another preference', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = {
      state: {
        appState: {
          theme: 'auto' as const,
          tuiMode: 'regular' as const,
          followUpBehavior: 'steer' as const,
          editorCommand: null,
          notifications: { enabled: true, condition: 'unfocused' as const },
          upgrade: { autoInstall: true },
        },
        ui: { mode: 'regular' as const },
      },
      setAppState: vi.fn(),
      showStatus: vi.fn(),
      showNotice: vi.fn(),
    };

    await applyTuiModeChoice(host, 'fullscreen');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tuiMode: 'fullscreen', followUpBehavior: 'steer' }),
    );
  });
});
