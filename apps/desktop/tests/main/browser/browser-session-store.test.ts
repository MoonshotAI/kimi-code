import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSessionStore } from '../../../src/main/browser/browser-session-store';
import { asBrowserPanelSessions } from '../../../src/shared/browser-panel-state';

const directories: string[] = [];
function stateFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'browser-session-store-'));
  directories.push(directory);
  return join(directory, 'browser-tabs.json');
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('restores session ownership, tab order, selected tab, blank tabs and full URLs from disk', () => {
  const file = stateFile();
  const store = new BrowserSessionStore(file);
  const sessions = [
    { sessionId: 'session-1', tabs: [{ browserId: 'a', title: 'A' }, { browserId: 'b' }], activeBrowserId: 'a', visible: true },
    { sessionId: 'session-2', tabs: [{ browserId: 'blank' }], activeBrowserId: null, visible: false },
  ];
  store.saveSessions(sessions);
  const url = `https://example.com/?query=${'x'.repeat(20000)}#section`;
  store.savePage('a', { url, title: 'A', zoomFactor: 1.25 });
  store.savePage('b', { url: 'https://example.org/updated', title: 'B', zoomFactor: 1 });
  store.flush();
  const restored = new BrowserSessionStore(file);
  expect(restored.getSessions()).toEqual(sessions);
  expect(restored.getPage('a')).toEqual({ url, title: 'A', zoomFactor: 1.25 });
  expect(restored.getPage('b')?.url).toBe('https://example.org/updated');
  expect(restored.getPage('blank')).toEqual({ url: '', title: '', zoomFactor: 1 });
});

it('removes closed tabs from disk even before the next renderer layout update', () => {
  const file = stateFile();
  const store = new BrowserSessionStore(file);
  store.saveSessions([{ sessionId: 'session-1', tabs: [{ browserId: 'a' }, { browserId: 'blank' }], activeBrowserId: 'a', visible: true }]);
  store.savePage('a', { url: 'https://example.com', title: 'A', zoomFactor: 1 });
  store.deletePage('a');
  expect(new BrowserSessionStore(file).getSessions()[0]).toEqual({ sessionId: 'session-1', tabs: [{ browserId: 'blank' }], activeBrowserId: null, visible: true });
  store.deletePage('blank');
  expect(new BrowserSessionStore(file).getSessions()).toEqual([]);
});

it('does not overwrite a corrupt file and rejects unsafe URLs', () => {
  const file = stateFile();
  writeFileSync(file, '{broken');
  expect(new BrowserSessionStore(file).getSessions()).toEqual([]);
  const backup = readdirSync(dirname(file)).find(name => name.startsWith('browser-tabs.json.invalid-'))!;
  expect(readFileSync(join(dirname(file), backup), 'utf8')).toBe('{broken');
  const store = new BrowserSessionStore(file);
  store.savePage('a', { url: 'javascript:alert(1)', title: '', zoomFactor: 1 });
  expect(store.getPage('a')).toBeUndefined();
});

it('keeps only durable layout fields and rejects duplicate identities', () => {
  const sessions = [{ sessionId: 'session-1', tabs: [{ browserId: 'a', controlled: { turnId: 'turn-1', status: 'running' } }], activeBrowserId: 'a', visible: true }];
  expect(asBrowserPanelSessions(sessions)?.[0]?.tabs[0]).toEqual({ browserId: 'a' });
  expect(asBrowserPanelSessions([...sessions, ...sessions])).toBeNull();
  expect(asBrowserPanelSessions([{ ...sessions[0], activeBrowserId: 'missing' }])).toBeNull();
  expect(asBrowserPanelSessions([{ ...sessions[0], sessionId: '__proto__' }])).toBeNull();
  expect(asBrowserPanelSessions([{ ...sessions[0], tabs: [{ browserId: 'constructor' }], activeBrowserId: null }])).toBeNull();
  expect(asBrowserPanelSessions([sessions[0], { sessionId: 'session-2', tabs: [{ browserId: 'a' }], activeBrowserId: null, visible: false }])).toBeNull();
});

it('validates layout field types and bounds through the shared browser validator', () => {
  const session = { sessionId: 'session-1', tabs: [{ browserId: 'a', title: 'Page', customTitle: 'Mine' }], activeBrowserId: null, visible: false, extra: true };
  expect(asBrowserPanelSessions([session])).toEqual([{ sessionId: 'session-1', tabs: [{ browserId: 'a', title: 'Page', customTitle: 'Mine' }], activeBrowserId: null, visible: false }]);
  expect(asBrowserPanelSessions([{ ...session, visible: 'yes' }])).toBeNull();
  expect(asBrowserPanelSessions([{ ...session, activeBrowserId: undefined }])).toBeNull();
  expect(asBrowserPanelSessions([{ ...session, tabs: [{ browserId: 'a', title: 'x'.repeat(513) }] }])).toBeNull();
  expect(asBrowserPanelSessions([{ ...session, tabs: [{ browserId: 'bad id' }] }])).toBeNull();
  expect(asBrowserPanelSessions({ sessions: [] })).toBeNull();
  expect(asBrowserPanelSessions([])).toEqual([]);
});

it.each([0.25, 0.33, 0.5, 1, 2, 2.5, 3, 4, 5])('restores a supported page zoom factor of %s', (zoomFactor) => {
  const file = stateFile();
  const store = new BrowserSessionStore(file);
  store.saveSessions([{ sessionId: 'session-1', tabs: [{ browserId: 'a' }], activeBrowserId: 'a', visible: true }]);
  store.savePage('a', { url: 'https://example.com/', title: 'A', zoomFactor });
  store.flush();
  expect(new BrowserSessionStore(file).getPage('a')?.zoomFactor).toBe(zoomFactor);
});

it('restores custom names and muted state without replacing the page title', () => {
  const file = stateFile();
  const store = new BrowserSessionStore(file);
  store.saveSessions([{ sessionId: 'session-menu', tabs: [{ browserId: 'tab-menu', title: 'Page title', customTitle: 'My map' }], activeBrowserId: 'tab-menu', visible: true }]);
  store.savePage('tab-menu', { url: 'https://example.com', title: 'Page title', zoomFactor: 1, muted: true });
  store.flush();
  const restored = new BrowserSessionStore(file);
  expect(restored.getSessions()[0]?.tabs[0]?.customTitle).toBe('My map');
  expect(restored.getPage('tab-menu')).toMatchObject({ title: 'Page title', muted: true });
});

it('restores a cached favicon without requiring another page event', () => {
  const file = stateFile();
  const store = new BrowserSessionStore(file);
  store.saveSessions([{ sessionId: 's', tabs: [{ browserId: 'a' }], activeBrowserId: 'a', visible: true }]);
  store.savePage('a', { url: 'https://example.com', title: 'Example', zoomFactor: 1, favicon: 'data:image/png;base64,aWNvbg==' });
  store.flush();
  expect(new BrowserSessionStore(file).getPage('a')?.favicon).toBe('data:image/png;base64,aWNvbg==');
});

it('coalesces page writes while exposing the latest in-memory state', () => {
  vi.useFakeTimers();
  try {
    const file = stateFile();
    const store = new BrowserSessionStore(file);
    store.saveSessions([{ sessionId: 's', tabs: [{ browserId: 'a' }], activeBrowserId: 'a', visible: true }]);
    store.flush();
    for (let i = 0; i < 100; i++) store.savePage('a', { url: 'https://example.com', title: String(i), zoomFactor: 1 });
    expect(store.getPage('a')?.title).toBe('99');
    expect(new BrowserSessionStore(file).getPage('a')?.url).toBe('');
    vi.advanceTimersByTime(250);
    expect(new BrowserSessionStore(file).getPage('a')?.title).toBe('99');
    store.setDefaultZoom(2);
    store.flush();
    expect(new BrowserSessionStore(file).getPage('a')?.zoomFactor).toBe(2);
  } finally { vi.useRealTimers(); }
});
