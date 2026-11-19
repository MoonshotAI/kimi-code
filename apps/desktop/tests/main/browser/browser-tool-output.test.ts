import { decode } from '@toon-format/toon';
import { describe, expect, it } from 'vitest';
import { elementRows, formatBrowserToolResult } from '../../../src/main/browser/browser-tool-output';
import type { BrowserRunResult, BrowserTabSnapshot } from '../../../src/shared/browser-automation';

function tab(index: number): BrowserTabSnapshot {
  return {
    tabId: `tab-${index}`, browserId: `browser-${index}`, active: index === 1, visible: index === 1, generation: index,
    url: `https://example.com/docs/page-${index}`, title: `Example page ${index}`,
    loading: false, canGoBack: index > 1, canGoForward: false,
  };
}

const state: BrowserRunResult = {
  ok: true,
  operation: 'browser.get_state',
  browser: { available: true, panelVisible: true, activeTabId: 'tab-1', visibleTabId: 'tab-1', tabs: [1, 2, 3, 4].map(tab) },
};

const elements: BrowserRunResult = {
  ok: true,
  operation: 'page.elements.snapshot',
  elements: {
    snapshotId: 'snap-1', scope: 'viewport', total: 3, maxChars: 8000, nextCursor: null,
    elements: [
      { ref: 'e1', role: 'link', name: 'Home', inViewport: true, bounds: { x: 0, y: 0, width: 40, height: 20 } },
      { ref: 'e2', role: 'textbox', name: 'Search', value: 'toon', inViewport: true, bounds: { x: 50, y: 0, width: 200, height: 20 } },
      { ref: 'e3', role: 'checkbox', name: 'Remember', checked: true, inViewport: false, bounds: { x: 0, y: 900, width: 20, height: 20 } },
    ],
  },
};

const results: BrowserRunResult[] = [
  state,
  { ok: true, operation: 'browser.get_history', history: [{ id: 'h1', url: 'https://example.com', title: 'Example', visitedAt: 1 }, { id: 'h2', url: 'https://example.org', title: 'Org', visitedAt: 2 }] },
  { ok: true, operation: 'browser.get_downloads', downloads: [{ id: 'd1', url: 'https://example.com/a.zip', filename: 'a.zip', state: 'completed', startedAt: 1, receivedBytes: 10, totalBytes: 10 }] },
  { ok: true, operation: 'tab.navigate', tab: tab(1), receipt: 'receipt-1' },
  { ok: true, operation: 'page.visual.click', receipt: 'receipt-2' },
  { ok: false, operation: 'tab.navigate', error: { code: 'BROWSER_USER_TAKEOVER', message: 'The user took control.' } },
  elements,
  { ok: true, operation: 'page.elements.snapshot', elements: { snapshotId: 'snap-2', elements: [] } },
];

describe('formatBrowserToolResult', () => {
  it.each(results.map(result => [result.operation, result] as const))('encodes %s as TOON without undefined fields', (_operation, result) => {
    const text = formatBrowserToolResult(result);
    expect(text.trimStart().startsWith('{')).toBe(false);
    const { elements: snapshot, ...rest } = result;
    expect(decode(text)).toEqual(JSON.parse(JSON.stringify(snapshot === undefined ? rest : { ...rest, elements: { ...snapshot, elements: elementRows(snapshot) } })));
  });

  it('keeps image bytes out of visual and crop metadata', () => {
    const visual = formatBrowserToolResult({
      ok: true, operation: 'page.visual.snapshot',
      visual: { snapshotId: 'v1', mimeType: 'image/png', data: 'cG5n', width: 100, height: 80, deviceScaleFactor: 2, viewport: { width: 50, height: 40 } },
    });
    expect(decode(visual)).toEqual({ ok: true, operation: 'page.visual.snapshot', visual: { snapshotId: 'v1', mimeType: 'image/png', width: 100, height: 80, deviceScaleFactor: 2, viewport: { width: 50, height: 40 } } });
    const crop = formatBrowserToolResult({
      ok: true, operation: 'page.visual.crop',
      crop: { sourceSnapshotId: 'v1', capturedAt: 5, region: { x: 1, y: 2, width: 3, height: 4 }, mimeType: 'image/png', data: 'cG5n', width: 3, height: 4 },
    });
    expect(crop).not.toContain('cG5n');
    expect(decode(crop)).toMatchObject({ crop: { sourceSnapshotId: 'v1', region: { x: 1, y: 2, width: 3, height: 4 } } });
  });

  it('keeps pending dialogs, handled dialogs and notices in results without elements or text', () => {
    const events = {
      pendingDialogs: [{ dialogId: 'dialog-2', tabId: 'tab-1', kind: 'confirm' as const, origin: 'https://example.test', message: 'Sure?', answerer: 'agent' as const, ageMs: 5 }],
      notices: ['The page tried to open the print dialog.'],
    };
    const formatted = formatBrowserToolResult({ ok: true, operation: 'page.dialog.get', ...events } as BrowserRunResult);
    expect(decode(formatted)).toMatchObject(events);
  });

  it('is no larger than JSON for representative state and element results', () => {
    expect(formatBrowserToolResult(state).length).toBeLessThanOrEqual(JSON.stringify(state).length);
    const { elements: snapshot, ...rest } = elements;
    const json = JSON.stringify({ ...rest, elements: { ...snapshot, elements: elementRows(snapshot!) } });
    expect(formatBrowserToolResult(elements).length).toBeLessThanOrEqual(json.length);
  });
});
