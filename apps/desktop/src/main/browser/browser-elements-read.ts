import { captureBrowserElements, currentBrowserElementSnapshot } from './browser-page';
import { getBrowserPage } from './browser-view';
import { BrowserReadCache, BrowserReadError, readCursor } from './browser-read-cache';
import { formatBrowserToolResult } from './browser-tool-output';
import { BROWSER_LOCAL_FILE_REFUSAL, type BrowserElementsSnapshot, type BrowserRunRequest } from '../../shared/browser-automation';

type Request = Extract<BrowserRunRequest, { operation: 'page.elements.snapshot' }>;
const cache = new BrowserReadCache<{ snapshot: BrowserElementsSnapshot; limit: number; maxChars: number }>();

export async function readBrowserElements(browserId: string, request: Request): Promise<BrowserElementsSnapshot> {
  const page = getBrowserPage(browserId);
  if (!page) throw new BrowserReadError('PAGE_NOT_READY', 'Browser page is unavailable.');
  if (page.localFile) throw new BrowserReadError('LOCAL_FILE_PAGE', BROWSER_LOCAL_FILE_REFUSAL);
  const owner = `${browserId}:${page.webContents.id}:${page.generation}`;
  let key: string;
  let offset: number;
  if ('cursor' in request) ({ key, offset } = readCursor(request.cursor));
  else {
    const snapshot = await captureBrowserElements(browserId, { scope: request.scope?.kind ?? 'viewport', filter: request.filter });
    key = cache.put(owner, { snapshot, limit: request.limit ?? 100, maxChars: request.maxChars ?? 8000 });
    offset = 0;
  }
  const { snapshot, limit, maxChars } = cache.get(owner, key);
  if (offset > snapshot.elements.length) throw new BrowserReadError('SNAPSHOT_EXPIRED', 'Invalid snapshot offset.');
  if ('cursor' in request && await currentBrowserElementSnapshot(browserId) !== snapshot.snapshotId) {
    throw new BrowserReadError('SNAPSHOT_EXPIRED', 'Element references were replaced; capture again.');
  }
  const result: BrowserElementsSnapshot = { ...snapshot, elements: [], total: snapshot.elements.length, maxChars, nextCursor: null };
  const update = () => {
    const next = offset + result.elements.length;
    result.nextCursor = next < snapshot.elements.length ? `${key}:${next}` : null;
    result.truncated = result.nextCursor !== null || snapshot.scanTruncated === true;
  };
  for (const element of snapshot.elements.slice(offset, offset + limit)) {
    result.elements.push(element);
    update();
    if (formatBrowserToolResult({ ok: true, operation: request.operation, elements: result }).length > maxChars) {
      result.elements.pop(); update(); break;
    }
  }
  update();
  if (result.elements.length === 0 && offset < snapshot.elements.length) throw new BrowserReadError('OUTPUT_LIMIT', 'An element exceeds maxChars; increase the output budget.');
  return result;
}
