// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  formatBrowserTabTitleMode,
  parseBrowserTabTitleSegments,
  STORAGE_KEYS,
} from '@moonshot-ai/app-core/lib';
import { useBrowserTabTitle } from '../src/composables/useBrowserTabTitle';

beforeEach(() => {
  localStorage.clear();
  useBrowserTabTitle().reloadBrowserTabTitle();
});

describe('parseBrowserTabTitleSegments & formatBrowserTabTitleMode', () => {
  it('normalizes missing, malformed, and duplicate entries back to both known tokens', () => {
    expect(parseBrowserTabTitleSegments(null)).toEqual([
      { id: 'workspace', enabled: true },
      { id: 'session', enabled: true },
    ]);
    expect(parseBrowserTabTitleSegments('{not-json')).toEqual([
      { id: 'workspace', enabled: true },
      { id: 'session', enabled: true },
    ]);
    expect(
      parseBrowserTabTitleSegments(
        JSON.stringify([
          { id: 'session', enabled: false },
          { id: 'session', enabled: true },
          { id: 'unknown', enabled: true },
        ]),
      ),
    ).toEqual([
      { id: 'session', enabled: false },
      { id: 'workspace', enabled: true },
    ]);
  });

  it('maps every segment state to a canonical telemetry mode', () => {
    expect(
      formatBrowserTabTitleMode([
        { id: 'workspace', enabled: true },
        { id: 'session', enabled: true },
      ]),
    ).toBe('workspace-session');
    expect(
      formatBrowserTabTitleMode([
        { id: 'session', enabled: true },
        { id: 'workspace', enabled: true },
      ]),
    ).toBe('session-workspace');
    expect(
      formatBrowserTabTitleMode([
        { id: 'workspace', enabled: true },
        { id: 'session', enabled: false },
      ]),
    ).toBe('workspace');
    expect(
      formatBrowserTabTitleMode([
        { id: 'session', enabled: true },
        { id: 'workspace', enabled: false },
      ]),
    ).toBe('session');
    expect(
      formatBrowserTabTitleMode([
        { id: 'workspace', enabled: false },
        { id: 'session', enabled: false },
      ]),
    ).toBe('none');
  });
});

describe('useBrowserTabTitle', () => {
  it('toggles, reorders, persists to STORAGE_KEYS.browserTabTitle, and syncs storage events', () => {
    const state = useBrowserTabTitle();
    expect(state.segments.value).toEqual([
      { id: 'workspace', enabled: true },
      { id: 'session', enabled: true },
    ]);

    state.moveSegment('session', 0);
    expect(state.segments.value).toEqual([
      { id: 'session', enabled: true },
      { id: 'workspace', enabled: true },
    ]);

    state.toggleSegment('workspace');
    expect(state.segments.value).toEqual([
      { id: 'session', enabled: true },
      { id: 'workspace', enabled: false },
    ]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.browserTabTitle)!)).toEqual([
      { id: 'session', enabled: true },
      { id: 'workspace', enabled: false },
    ]);

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: STORAGE_KEYS.browserTabTitle,
        newValue: JSON.stringify([
          { id: 'workspace', enabled: true },
          { id: 'session', enabled: false },
        ]),
      }),
    );
    expect(state.segments.value).toEqual([
      { id: 'workspace', enabled: true },
      { id: 'session', enabled: false },
    ]);
  });
});
