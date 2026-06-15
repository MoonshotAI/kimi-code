import { afterEach, describe, expect, it, vi } from 'vitest';

import { clipboard } from '#/utils/clipboard/clipboard-native';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';

vi.mock('#/utils/clipboard/clipboard-native', () => ({
  clipboard: {
    setText: vi.fn(),
  },
}));

const clipboardMock = clipboard as unknown as { setText: ReturnType<typeof vi.fn> };

afterEach(() => {
  vi.clearAllMocks();
});

describe('copyTextToClipboard', () => {
  it('copies text with the native clipboard when available', async () => {
    clipboardMock.setText.mockResolvedValue(undefined);

    await expect(copyTextToClipboard('cd "/tmp/proj-b"')).resolves.toBeUndefined();
    expect(clipboardMock.setText).toHaveBeenCalledWith('cd "/tmp/proj-b"');
  });
});
