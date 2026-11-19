import type { BrowserReceiptImage } from '../../shared/browser-receipt';

interface BrowserReceiptBridge {
  browserReadReceipt: (sessionId: string, receiptId: string) => Promise<BrowserReceiptImage | null>;
  browserDeleteReceipts: (sessionId: string) => Promise<void>;
  browserCopyReceipts: (sourceId: string, targetId: string) => Promise<void>;
}

export function getBrowserReceiptBridge(): BrowserReceiptBridge | null {
  const bridge = (window as { kimiDesktop?: Partial<BrowserReceiptBridge> }).kimiDesktop;
  return typeof bridge?.browserReadReceipt === 'function' && typeof bridge.browserDeleteReceipts === 'function' && typeof bridge.browserCopyReceipts === 'function'
    ? bridge as BrowserReceiptBridge
    : null;
}

export function deleteBrowserReceipts(sessionId: string): void {
  void getBrowserReceiptBridge()?.browserDeleteReceipts(sessionId).catch(error => console.error('Could not delete browser receipts', error));
}

export async function copyBrowserReceipts(sourceId: string, targetId: string): Promise<void> {
  await getBrowserReceiptBridge()?.browserCopyReceipts(sourceId, targetId).catch(error => console.error('Could not copy browser receipts', error));
}
