import { randomUUID } from 'node:crypto';
import { getBrowserPage } from './browser-view';
import { BrowserReadCache, BrowserReadError, readCursor } from './browser-read-cache';
import { formatBrowserToolResult } from './browser-tool-output';
import { collectBrowserText } from './browser-text-script';
import { BROWSER_LOCAL_FILE_REFUSAL, type BrowserRunRequest, type BrowserTextSnapshot } from '../../shared/browser-automation';

const cache = new BrowserReadCache<{ snapshot: BrowserTextSnapshot; maxChars: number }>();

export async function readBrowserText(browserId: string, request: Extract<BrowserRunRequest, { operation: 'page.text.snapshot' }>): Promise<BrowserTextSnapshot> {
  const page = getBrowserPage(browserId);
  if (!page) throw new BrowserReadError('PAGE_NOT_READY', 'Browser page is unavailable.');
  if (page.localFile) throw new BrowserReadError('LOCAL_FILE_PAGE', BROWSER_LOCAL_FILE_REFUSAL);
  const owner = `${browserId}:${page.webContents.id}:${page.generation}`;
  let key: string;
  let offset: number;
  if ('cursor' in request) ({ key, offset } = readCursor(request.cursor));
  else {
    const scope = request.scope ?? { kind: 'viewport' as const };
    let content: ReturnType<typeof collectBrowserText>;
    try {
      content = await page.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${collectBrowserText.toString()})(${JSON.stringify(scope)})` }]) as ReturnType<typeof collectBrowserText>;
    } catch (error) {
      if (String(error).includes('STALE_ELEMENT:')) throw new BrowserReadError('STALE_ELEMENT', 'Text scope is no longer connected to the captured document.');
      if (String(error).includes('PAGE_NOT_READY:')) throw new BrowserReadError('PAGE_NOT_READY', 'Document body is not ready for text reading.');
      throw error;
    }
    const current = getBrowserPage(browserId);
    if (current?.webContents !== page.webContents || current.generation !== page.generation) throw new BrowserReadError('PAGE_NOT_READY', 'Browser page changed while reading text.');
    const snapshot: BrowserTextSnapshot = { snapshotId: `text-${randomUUID()}`, source: 'dom', scope: scope.kind,
      capturedAt: Date.now(), ...content, truncated: content.scanTruncated, nextCursor: null, maxChars: request.maxChars ?? 12000 };
    key = cache.put(owner, { snapshot, maxChars: snapshot.maxChars });
    offset = 0;
  }
  const { snapshot, maxChars } = cache.get(owner, key);
  if (offset > snapshot.blocks.length) throw new BrowserReadError('SNAPSHOT_EXPIRED', 'Invalid text snapshot offset.');
  const result: BrowserTextSnapshot = { ...snapshot, blocks: [] };
  const update = () => {
    const next = offset + result.blocks.length;
    result.nextCursor = next < snapshot.blocks.length ? `${key}:${next}` : null;
    result.truncated = result.nextCursor !== null || snapshot.scanTruncated;
  };
  for (const block of snapshot.blocks.slice(offset)) {
    result.blocks.push(block); update();
    if (formatBrowserToolResult({ ok: true, operation: request.operation, text: result }).length > maxChars) {
      result.blocks.pop(); update(); break;
    }
  }
  update();
  if (result.blocks.length === 0 && offset < snapshot.blocks.length) throw new BrowserReadError('OUTPUT_LIMIT', 'Text block exceeds the output budget.');
  return result;
}
