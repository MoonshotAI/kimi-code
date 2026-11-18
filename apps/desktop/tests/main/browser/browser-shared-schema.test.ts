import { describe, expect, it } from 'vitest';
import { asBrowserBounds, isBrowserState } from '../../../src/shared/browser';
import { asBrowserHistoryEntry, asBrowserDownloadEntry } from '../../../src/shared/browser-data-records';
import { asBrowserDeviceModeRequest, BROWSER_DEVICE_PROFILES, BrowserDeviceModeRequestSchema } from '../../../src/shared/browser-device';
import { asBrowserOverlayMenuRequest, asBrowserOverlayDialogRequest, asBrowserOverlayRendered } from '../../../src/shared/browser-overlay';
import { asBrowserSiteRecord, asBrowserSiteInfo } from '../../../src/shared/browser-sites';
import { isBrowserControlConfig } from '../../../src/shared/browser-control';
import { BROWSER_DIALOG_RECORD_ANSWERERS, BROWSER_DIALOG_RECORD_KINDS, BROWSER_DIALOG_RECORD_OUTCOMES } from '../../../src/shared/browser-dialogs';
import { Value } from 'typebox/value';

const menu = { menuId: 'menu', anchor: { x: 1.4, y: 2.6, width: 900.4, height: 20.1 }, items: [{ kind: 'item', id: 'open', label: 'Open' }] };
const dialog = { dialogId: 'dialog', title: 'Title', confirmLabel: 'OK', cancelLabel: 'Cancel', closeLabel: 'Close' };

describe('shared browser schemas and normalization', () => {
  it.each(BROWSER_DEVICE_PROFILES)('accepts profile $id in both the shared parser and MCP device schema', profile => {
    for (const scale of [undefined, 0.01, 1]) {
      const request = { enabled: true, profileId: profile.id, orientation: 'portrait',
        ...(profile.id === 'responsive' ? { width: 50, height: 9999 } : {}),
        ...(scale === undefined ? { scaleMode: 'fit' } : { scaleMode: 'fixed', scale }),
      };
      expect(asBrowserDeviceModeRequest(request)).toEqual(request);
      expect(Value.Check(BrowserDeviceModeRequestSchema, request)).toBe(true);
    }
  });

  it('keeps normalization distinct from strict MCP validation', () => {
    expect(asBrowserDeviceModeRequest({ enabled: false, width: 400 })).toEqual({ enabled: false });
    expect(Value.Check(BrowserDeviceModeRequestSchema, { enabled: false, width: 400 })).toBe(false);
    expect(asBrowserDeviceModeRequest({ enabled: true, profileId: 'iphone-16', orientation: 'portrait', scaleMode: 'fit', width: 400 })).toBeNull();
  });

  it('preserves rounding and rejects invalid geometry', () => {
    expect(asBrowserBounds({ ...menu.anchor, extra: true })).toEqual({ x: 1, y: 3, width: 900, height: 20 });
    expect(asBrowserBounds({ ...menu.anchor, x: -1 })).toBeNull();
    expect(asBrowserBounds({ ...menu.anchor, width: Infinity })).toBeNull();
    expect(asBrowserOverlayRendered({ requestId: 1, width: 200.1, height: 1100.1 })).toEqual({ requestId: 1, width: 201, height: 1101 });
    expect(asBrowserOverlayRendered({ requestId: Number.MAX_SAFE_INTEGER + 1, width: 200, height: 200 })).toBeNull();
  });

  it('preserves menu defaults and focus-dependent width limits', () => {
    expect(asBrowserOverlayMenuRequest(menu)).toEqual({ ...menu, anchor: { x: 1, y: 3, width: 900, height: 20 }, placement: 'bottom-end', offset: 4, width: 220 });
    expect(asBrowserOverlayMenuRequest({ ...menu, width: 800 })).toBeNull();
    expect(asBrowserOverlayMenuRequest({ ...menu, width: 800, preserveFocus: true })?.width).toBe(800);
    expect(asBrowserOverlayMenuRequest({ ...menu, footerStart: 2 })).toBeNull();
    expect(asBrowserOverlayMenuRequest({ ...menu, items: [...menu.items, ...menu.items] })).toBeNull();
    expect(asBrowserOverlayMenuRequest({ ...menu, items: [{ kind: 'separator' }] })).toBeNull();
  });

  it('projects menu items without mutating or traversing discarded fields', () => {
    const discarded: { self?: unknown } = {}; discarded.self = discarded;
    const options = [{ id: 'a', label: 'A', discarded }];
    const request = { ...menu, items: [{ kind: 'choices', id: 'choice', label: '', value: 'a', options, discarded }] };
    const parsed = asBrowserOverlayMenuRequest(request);
    expect(parsed?.items).toEqual([{ kind: 'choices', id: 'choice', label: '', value: 'a', options: [{ id: 'a', label: 'A' }] }]);
    expect(request.items[0]?.discarded).toBe(discarded);
    expect(parsed?.items[0]).not.toBe(request.items[0]);
    expect(asBrowserOverlayMenuRequest({ ...menu, items: [{ ...request.items[0], value: 'missing' }] })).toBeNull();
  });

  it('preserves dialog defaults, strict fields and viewport limits', () => {
    expect(asBrowserOverlayDialogRequest(dialog)).toEqual({ ...dialog, anchor: undefined, variant: 'danger' });
    expect(asBrowserOverlayDialogRequest({ ...dialog, extra: true })).toBeNull();
    expect(asBrowserOverlayDialogRequest({ ...dialog, viewport: { width: 16385, height: 10 } })).toBeNull();
    expect(asBrowserOverlayDialogRequest({ ...dialog, preview: { src: 'https://example.com/a.png', alt: '' } })).toBeNull();
    const input = { label: '', value: '', ignored: true };
    expect(asBrowserOverlayDialogRequest({ ...dialog, input })?.input).toEqual({ label: '', value: '', placeholder: undefined, readOnly: undefined });
    expect(input.ignored).toBe(true);
  });

  it('sanitizes record fields and preserves existing numeric semantics', () => {
    const history = { id: '', url: '', title: '', visitedAt: -1, favicon: 'javascript:alert(1)', extra: true };
    expect(asBrowserHistoryEntry(history)).toEqual({ id: '', url: '', title: '', visitedAt: -1 });
    expect(history.favicon).toBe('javascript:alert(1)');
    const download = { id: 'd', url: 'https://example.com', filename: 'a.pdf', state: 'completed', startedAt: 0, receivedBytes: 0, totalBytes: 0 };
    expect(asBrowserDownloadEntry({ ...download, extra: true })).toEqual(download);
    expect(asBrowserDownloadEntry({ ...download, state: 'unknown' })).toBeNull();
    expect(asBrowserDownloadEntry({ ...download, savePath: 'x'.repeat(4097) })).toBeNull();
    const resume = { urlChain: ['https://example.com/a', 'https://cdn.example.com/a'], mimeType: 'application/zip', eTag: '"v1"', lastModified: 'Tue, 15 Sep 2026 10:00:00 GMT' };
    expect(asBrowserDownloadEntry({ ...download, resume: { ...resume, extra: true } })).toEqual({ ...download, resume });
    expect(asBrowserDownloadEntry({ ...download, resume: { ...resume, urlChain: [] } })).toBeNull();
    expect(asBrowserDownloadEntry({ ...download, resume: { ...resume, urlChain: Array(9).fill('https://example.com/a') } })).toBeNull();
    expect(asBrowserDownloadEntry({ ...download, resume: { ...resume, eTag: 'e'.repeat(1_025) } })).toBeNull();
    expect(asBrowserDownloadEntry({ ...download, resume: { ...resume, urlChain: [42] } })).toBeNull();
  });

  it('normalizes origins and validates permission names and settings', () => {
    const record = { origin: 'https://EXAMPLE.com/path', lastVisitedAt: 0, permissions: { camera: 'ask' } };
    expect(asBrowserSiteRecord(record)).toEqual({ ...record, origin: 'https://example.com' });
    expect(asBrowserSiteRecord({ ...record, permissions: { unknown: 'allow' } })).toBeNull();
    expect(asBrowserSiteRecord({ ...record, permissions: { camera: 'unknown' } })).toBeNull();
    expect(asBrowserSiteRecord({ ...record, permissions: { camera: undefined } })).toBeNull();
    expect(asBrowserSiteInfo({ ...record, cookieCount: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
  });

  it('keeps semantic favicon validation and bounded control labels', () => {
    const state = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
    expect(isBrowserState({ ...state, favicon: 'data:image/png;base64,AA==' })).toBe(true);
    expect(isBrowserState({ ...state, favicon: 'javascript:alert(1)' })).toBe(false);
    const activities = { reading: '', inspecting: '', capturing: '', clicking: '', hovering: '', typing: '', pressing: '', selecting: '', checking: '', scrolling: '', dragging: '', navigating: '', waiting: '', answering: '' };
    const labels = { running: '', elapsed: '', takeover: '', takeoverHint: '', pointer: '', typing: '', key: '', scrolling: '', activityTarget: '', activities };
    expect(isBrowserControlConfig({ controls: [], labels, colorScheme: 'light', reducedMotion: false })).toBe(true);
    const map = (names: readonly string[]) => Object.fromEntries(names.map(name => [name, name]));
    const dialogs = { button: 'b', title: 't', answeredBy: '{outcome} {answerer}', showInFolder: 's', move: 'm', kinds: map(BROWSER_DIALOG_RECORD_KINDS), outcomes: map(BROWSER_DIALOG_RECORD_OUTCOMES), answerers: map(BROWSER_DIALOG_RECORD_ANSWERERS) };
    expect(isBrowserControlConfig({ controls: [], labels: { ...labels, dialogs }, colorScheme: 'light', reducedMotion: false })).toBe(true);
    expect(isBrowserControlConfig({ controls: [], labels: { ...labels, dialogs: { ...dialogs, kinds: { ...dialogs.kinds, print: undefined } } }, colorScheme: 'light', reducedMotion: false })).toBe(false);
    expect(isBrowserControlConfig({ controls: [], labels: { ...labels, running: 'x'.repeat(501) }, colorScheme: 'light', reducedMotion: false })).toBe(false);
  });
});
