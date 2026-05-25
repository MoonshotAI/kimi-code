import { describe, expect, it, vi } from 'vitest';

import {
  detectTmuxKeyboardWarning,
  TMUX_EXTENDED_KEYS_FORMAT_XTERM_WARNING,
  TMUX_EXTENDED_KEYS_OFF_WARNING,
  type TmuxOptionReader,
} from '#/tui/utils/tmux-keyboard';

function optionReader(values: Record<string, string | undefined>): TmuxOptionReader {
  return vi.fn(async (option: string) => values[option]);
}

describe('tmux keyboard setup detection', () => {
  it('skips checks outside tmux', async () => {
    const readOption = optionReader({});

    await expect(detectTmuxKeyboardWarning({}, readOption)).resolves.toBeUndefined();

    expect(readOption).not.toHaveBeenCalled();
  });

  it('does not warn when tmux options cannot be queried', async () => {
    const readOption = optionReader({
      'extended-keys': undefined,
      'extended-keys-format': undefined,
    });

    await expect(
      detectTmuxKeyboardWarning({ TMUX: '/tmp/tmux/default,123,0' }, readOption),
    ).resolves.toBeUndefined();
  });

  it('warns when extended-keys is off', async () => {
    const readOption = optionReader({
      'extended-keys': 'off',
      'extended-keys-format': 'csi-u',
    });

    await expect(
      detectTmuxKeyboardWarning({ TMUX: '/tmp/tmux/default,123,0' }, readOption),
    ).resolves.toBe(TMUX_EXTENDED_KEYS_OFF_WARNING);
  });

  it('warns when extended-keys-format is xterm', async () => {
    const readOption = optionReader({
      'extended-keys': 'on',
      'extended-keys-format': 'xterm',
    });

    await expect(
      detectTmuxKeyboardWarning({ TMUX: '/tmp/tmux/default,123,0' }, readOption),
    ).resolves.toBe(TMUX_EXTENDED_KEYS_FORMAT_XTERM_WARNING);
  });

  it('accepts on and always with csi-u or absent format', async () => {
    await expect(
      detectTmuxKeyboardWarning(
        { TMUX: '/tmp/tmux/default,123,0' },
        optionReader({ 'extended-keys': 'on', 'extended-keys-format': 'csi-u' }),
      ),
    ).resolves.toBeUndefined();

    await expect(
      detectTmuxKeyboardWarning(
        { TMUX: '/tmp/tmux/default,123,0' },
        optionReader({ 'extended-keys': 'always', 'extended-keys-format': undefined }),
      ),
    ).resolves.toBeUndefined();
  });
});
