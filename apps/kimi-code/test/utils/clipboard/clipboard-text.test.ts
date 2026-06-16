import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clipboard } from '#/utils/clipboard/clipboard-native';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('#/utils/clipboard/clipboard-native', () => ({
  clipboard: {
    setText: vi.fn(),
  },
}));

const clipboardMock = clipboard as unknown as { setText: ReturnType<typeof vi.fn> };
const spawnSyncMock = vi.mocked(spawnSync);

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  spawnSyncMock.mockImplementation(() => {
    throw new Error('platform clipboard fallback should not run');
  });
});

describe('copyTextToClipboard', () => {
  it('copies text with the native clipboard when available', async () => {
    clipboardMock.setText.mockResolvedValue(undefined);

    await expect(copyTextToClipboard('cd "/tmp/proj-b"')).resolves.toBeUndefined();
    expect(clipboardMock.setText).toHaveBeenCalledWith('cd "/tmp/proj-b"');
  });

  it('keeps native clipboard method context when copying text', async () => {
    clipboardMock.setText.mockImplementation(function (this: unknown, text: string): void {
      expect(this).toBe(clipboardMock);
      expect(text).toBe('cd "/tmp/proj-b"');
    });

    await expect(copyTextToClipboard('cd "/tmp/proj-b"')).resolves.toBeUndefined();
  });

  it('throws an Error when all platform clipboard commands fail', async () => {
    clipboardMock.setText = undefined as unknown as ReturnType<typeof vi.fn>;
    spawnSyncMock.mockReturnValue({ status: 1, stderr: 'missing' } as ReturnType<typeof spawnSync>);

    await expect(copyTextToClipboard('cd "/tmp/proj-b"')).rejects.toBeInstanceOf(Error);
    await expect(copyTextToClipboard('cd "/tmp/proj-b"')).rejects.toThrow(
      /(?:clip\.exe|pbcopy|wl-copy|xclip) exited with code 1: missing/,
    );
  });
});
