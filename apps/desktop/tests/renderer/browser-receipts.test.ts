import { afterEach, expect, it, vi } from 'vitest';
import { copyBrowserReceipts, deleteBrowserReceipts, getBrowserReceiptBridge } from '../../src/renderer/lib/browserReceipts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubBridge(bridge: Record<string, unknown> | undefined) {
  vi.stubGlobal('window', { kimiDesktop: bridge });
}

it('uses the desktop receipt bridge only when all of it is available', () => {
  stubBridge(undefined);
  expect(getBrowserReceiptBridge()).toBeNull();
  stubBridge({ browserReadReceipt: vi.fn(), browserDeleteReceipts: vi.fn() });
  expect(getBrowserReceiptBridge()).toBeNull();
  const full = { browserReadReceipt: vi.fn(), browserDeleteReceipts: vi.fn(), browserCopyReceipts: vi.fn() };
  stubBridge(full);
  expect(getBrowserReceiptBridge()).toBe(full);
});

it('deletes and copies session receipts without failing the session operation', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const bridge = {
    browserReadReceipt: vi.fn(),
    browserDeleteReceipts: vi.fn(async (sessionId: string) => { if (sessionId === 'broken') throw new Error('disk'); }),
    browserCopyReceipts: vi.fn(async () => { throw new Error('disk'); }),
  };
  stubBridge(bridge);
  deleteBrowserReceipts('session_1');
  deleteBrowserReceipts('broken');
  await expect(copyBrowserReceipts('session_1', 'session_2')).resolves.toBeUndefined();
  await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));
  expect(bridge.browserDeleteReceipts.mock.calls).toEqual([['session_1'], ['broken']]);
  expect(bridge.browserCopyReceipts).toHaveBeenCalledWith('session_1', 'session_2');

  stubBridge(undefined);
  expect(() => deleteBrowserReceipts('session_1')).not.toThrow();
  await expect(copyBrowserReceipts('session_1', 'session_2')).resolves.toBeUndefined();
});
