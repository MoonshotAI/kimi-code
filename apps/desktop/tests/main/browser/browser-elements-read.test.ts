import { beforeEach, expect, it, vi } from 'vitest';
import { decode, encode } from '@toon-format/toon';
import { readBrowserElements } from '../../../src/main/browser/browser-elements-read';
import { formatBrowserToolResult, elementRows } from '../../../src/main/browser/browser-tool-output';
import { BrowserReadCache } from '../../../src/main/browser/browser-read-cache';
import { asBrowserRunRequest } from '../../../src/shared/browser-automation';

const mocks = vi.hoisted(() => ({ generation: 1, snapshotId: 'elements-1', capture: vi.fn() }));
vi.mock('../../../src/main/browser/browser-view', () => ({ getBrowserPage: () => ({ generation: mocks.generation, webContents: { id: 1 } }) }));
vi.mock('../../../src/main/browser/browser-page', () => ({ captureBrowserElements: mocks.capture, currentBrowserElementSnapshot: async () => mocks.snapshotId }));
const base = { protocol: 'kimi.browser/1.0.0' as const, operation: 'page.elements.snapshot' as const, tabId: 'tab-1' };
const elements = Array.from({ length: 30 }, (_, i) => ({ ref: `e${i}`, role: 'link', name: `新闻, "${i}"\n内容`, text: `新闻, "${i}"\n内容`, bounds: { x: 0, y: i * 20, width: 100, height: 20 }, inViewport: true }));
beforeEach(() => { mocks.generation = 1; mocks.snapshotId = 'elements-1'; mocks.capture.mockReset().mockResolvedValue({ snapshotId: mocks.snapshotId, scope: 'viewport', elements }); });

it('returns bounded TOON records with round-trip-safe text and frozen pagination', async () => {
  const first = await readBrowserElements('browser-1', { ...base, limit: 2, maxChars: 2048 });
  const text = formatBrowserToolResult({ ok: true, operation: base.operation, elements: first });
  expect(text.length).toBeLessThanOrEqual(2048);
  expect(decode(text)).toMatchObject({ elements: { elements: elementRows(first), total: 30 } });
  expect(text).not.toContain('bounds');
  expect(text).toContain('elements[2]');
  expect(first.nextCursor).toBeTruthy();
  const second = await readBrowserElements('browser-1', { ...base, cursor: first.nextCursor! });
  expect(second.elements.map(item => item.ref)).toEqual(['e2', 'e3']);
  expect(mocks.capture).toHaveBeenCalledOnce();
  expect(await readBrowserElements('browser-1', { ...base, cursor: first.nextCursor! })).toEqual(second);
});

it('rejects cross-tab, replaced-document and replaced-reference cursors', async () => {
  const first = await readBrowserElements('browser-1', { ...base, limit: 1 });
  const next = { ...base, cursor: first.nextCursor! };
  await expect(readBrowserElements('browser-2', next)).rejects.toMatchObject({ code: 'SNAPSHOT_EXPIRED' });
  mocks.generation++;
  await expect(readBrowserElements('browser-1', next)).rejects.toMatchObject({ code: 'SNAPSHOT_EXPIRED' });
  mocks.generation--;
  mocks.snapshotId = 'elements-2';
  await expect(readBrowserElements('browser-1', next)).rejects.toMatchObject({ code: 'SNAPSHOT_EXPIRED' });
});

it('distinguishes scan truncation from remaining pages and enforces request unions', async () => {
  mocks.capture.mockResolvedValue({ snapshotId: 'elements-1', elements: [], scanTruncated: true });
  expect(await readBrowserElements('browser-1', base)).toMatchObject({ nextCursor: null, truncated: true, scanTruncated: true });
  expect(asBrowserRunRequest({ ...base, cursor: 'cursor', scope: 'document' })).toBeNull();
  expect(asBrowserRunRequest({ ...base, maxChars: 24001 })).toBeNull();
  expect(asBrowserRunRequest({ ...base, scope: 'document', filter: { text: '新闻', role: 'link' } })).not.toBeNull();
  expect(asBrowserRunRequest({ ...base, scope: { kind: 'document' }, filter: { text: '新闻', role: 'link' } })).not.toBeNull();
});

it('captures the scope kind from the object form', async () => {
  await readBrowserElements('browser-1', { ...base, scope: { kind: 'document' }, filter: { role: 'link' } });
  expect(mocks.capture).toHaveBeenCalledWith('browser-1', { scope: 'document', filter: { role: 'link' } });
  await readBrowserElements('browser-1', base);
  expect(mocks.capture).toHaveBeenLastCalledWith('browser-1', { scope: 'viewport', filter: undefined });
});

it('expires cached snapshots and enforces the retained byte budget', () => {
  vi.useFakeTimers();
  try {
    const cache = new BrowserReadCache<string>(10, 100);
    const first = cache.put('tab', 'a', 6);
    cache.put('tab', 'b', 6);
    expect(() => cache.get('tab', first)).toThrow('Snapshot is unavailable');
    const second = cache.put('tab', 'c', 6);
    vi.advanceTimersByTime(100);
    expect(() => cache.get('tab', second)).toThrow('Snapshot is unavailable');
  } finally { vi.useRealTimers(); }
});

it('compares formats on identical projected records rather than counting removed fields as format savings', () => {
  const projected = { elements: elementRows({ snapshotId: 's', elements }) };
  const toon = encode(projected);
  expect(decode(toon)).toEqual(projected);
  expect(toon.length).toBeLessThan(JSON.stringify(projected).length);
});

const events = {
  pendingDialogs: [{ dialogId: 'dialog-2', tabId: 'tab-1', kind: 'confirm' as const, origin: 'https://example.test', message: 'Sure?', answerer: 'agent' as const, ageMs: 5 }],
  handledDialogs: [{ id: 'record-1', kind: 'upload' as const, origin: 'https://example.test', outcome: 'accepted' as const, answerer: 'user' as const, openedAt: 1, settledAt: 2, files: ['/Users/me/id.png'] }],
  notices: ['The page tried to open the print dialog.'],
};

it('keeps pending and handled dialogs and notices in the formatted snapshot', async () => {
  const first = await readBrowserElements('browser-1', { ...base, limit: 2, maxChars: 2048 });
  const formatted = formatBrowserToolResult({ ok: true, operation: base.operation, elements: first, ...events });
  expect(decode(formatted)).toMatchObject(events);
});
