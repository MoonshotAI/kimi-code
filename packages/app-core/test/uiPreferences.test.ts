import { beforeEach, describe, expect, it, vi } from 'vitest';

const memStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void memStorage.set(key, value),
  removeItem: (key: string) => void memStorage.delete(key),
  clear: () => memStorage.clear(),
});

import {
  legacyUiPreferenceValues,
  loadOnboarded,
  loadPinnedSessions,
  loadSidebarViewMode,
  loadWorkspaceRecencyFloor,
  saveOnboarded,
  savePinnedSessions,
  saveSidebarViewMode,
  saveWorkspaceRecencyFloor,
  STORAGE_KEYS,
  UI_PREFERENCE_KEYS,
  uiPreferences,
  uiPreferenceWriteOps,
} from '../src/lib';

const SERVER = 'http://127.0.0.1:58627';
const PINNED = UI_PREFERENCE_KEYS.sidebarPinnedSessions;

function serverMode(values: Record<string, unknown> = {}, revision = 1): void {
  uiPreferences.bind(SERVER);
  uiPreferences.applySnapshot({ revision, values });
}

describe('UI preferences before the server answers', () => {
  beforeEach(() => {
    memStorage.clear();
    uiPreferences.bind(SERVER);
  });

  it('keeps reading and writing the legacy keys when this server has no cached preferences', () => {
    memStorage.set(STORAGE_KEYS.pinnedSessions, JSON.stringify(['s1']));

    savePinnedSessions(['s1', 's2']);

    expect(uiPreferences.mode).toBe('local');
    expect(loadPinnedSessions()).toEqual(['s1', 's2']);
    expect(memStorage.get(STORAGE_KEYS.pinnedSessions)).toBe('["s1","s2"]');
  });

  it('renders from the cache this server confirmed last time', () => {
    serverMode({ [PINNED]: ['cached'] });
    memStorage.set(STORAGE_KEYS.pinnedSessions, JSON.stringify(['legacy']));

    uiPreferences.bind(SERVER);

    expect(uiPreferences.mode).toBe('server');
    expect(loadPinnedSessions()).toEqual(['cached']);
  });

  it('shows what this browser last showed, not a server cache, after switching to a server it has not synced with', () => {
    serverMode({ [PINNED]: ['from-a'] });

    uiPreferences.bind('http://127.0.0.1:9000');

    expect(uiPreferences.mode).toBe('local');
    expect(uiPreferences.value(PINNED)).toBeUndefined();
    expect(loadPinnedSessions()).toEqual(['from-a']);
  });
});

describe('UI preference writes', () => {
  beforeEach(() => {
    memStorage.clear();
    uiPreferences.bind(SERVER);
  });

  it('turns pin and unpin into add and remove so other clients keep their pins', () => {
    expect(uiPreferenceWriteOps(PINNED, ['a', 'b'], ['a', 'c'])).toEqual([
      { op: 'remove', key: PINNED, value: 'b' },
      { op: 'add', key: PINNED, value: 'c' },
    ]);
  });

  it('writes the whole list when only the order changed', () => {
    expect(uiPreferenceWriteOps(PINNED, ['a', 'b'], ['b', 'a'])).toEqual([
      { op: 'set', key: PINNED, value: ['b', 'a'] },
    ]);
  });

  it('writes map entries one field at a time', () => {
    const key = UI_PREFERENCE_KEYS.sidebarWorkspaceRecencyFloor;
    expect(uiPreferenceWriteOps(key, { a: 1, b: 2 }, { a: 1, c: 3 })).toEqual([
      { op: 'unset_field', key, field: 'b' },
      { op: 'set_field', key, field: 'c', value: 3 },
    ]);
  });

  it('applies a write locally, queues it and keeps the legacy key in step for older versions', () => {
    serverMode();
    const changed: string[][] = [];
    const stop = uiPreferences.onChange((keys) => changed.push([...keys]));

    saveSidebarViewMode('flat');
    saveSidebarViewMode('grouped');
    stop();

    expect(loadSidebarViewMode()).toBe('grouped');
    expect(memStorage.get(STORAGE_KEYS.sidebarViewMode)).toBe('grouped');
    expect(changed).toEqual([[UI_PREFERENCE_KEYS.sidebarViewMode], [UI_PREFERENCE_KEYS.sidebarViewMode]]);
    expect(uiPreferences.takeQueued()).toEqual([
      { op: 'set', key: UI_PREFERENCE_KEYS.sidebarViewMode, value: 'grouped' },
    ]);
  });

  it('stores onboarding as a boolean on the server and as 1/0 locally', () => {
    saveOnboarded(true);
    expect(memStorage.get(STORAGE_KEYS.onboarded)).toBe('1');

    serverMode();
    saveOnboarded(false);
    expect(loadOnboarded()).toBe(false);
    expect(uiPreferences.takeQueued()).toEqual([
      { op: 'set', key: UI_PREFERENCE_KEYS.onboardingCompleted, value: false },
    ]);
  });
});

describe('UI preference sync', () => {
  beforeEach(() => {
    memStorage.clear();
    uiPreferences.bind(SERVER);
  });

  it('keeps a pending local edit when another client changes the same key', () => {
    serverMode({ [PINNED]: ['a'] }, 3);
    savePinnedSessions(['a', 'mine']);
    const ops = uiPreferences.takeQueued();

    uiPreferences.applyEvent(4, { [PINNED]: ['a', 'theirs'], [UI_PREFERENCE_KEYS.sidebarViewMode]: 'flat' });

    expect(loadPinnedSessions()).toEqual(['a', 'mine']);
    expect(loadSidebarViewMode()).toBe('flat');
    expect(uiPreferences.settle(ops, { [PINNED]: ['a', 'theirs', 'mine'] })).toBe(false);
    expect(loadPinnedSessions()).toEqual(['a', 'theirs', 'mine']);
  });

  it('asks for a refresh when a skipped change was not covered by the write result', () => {
    serverMode({ [PINNED]: ['a'] }, 3);
    savePinnedSessions([]);
    const ops = uiPreferences.takeQueued();
    uiPreferences.applyEvent(4, { [PINNED]: ['a', 'theirs'] });

    expect(uiPreferences.settle(ops, {})).toBe(true);
  });

  it('does not apply events that are not newer than the snapshot and reports an older one as behind', () => {
    serverMode({ [PINNED]: ['now'] }, 5);

    expect(uiPreferences.applyEvent(5, { [PINNED]: ['stale'] })).toBe('ignored');
    expect(uiPreferences.applyEvent(4, { [PINNED]: null })).toBe('behind');

    expect(loadPinnedSessions()).toEqual(['now']);
  });

  it('replays queued writes on top of a fresh snapshot', () => {
    serverMode({ [PINNED]: ['a'] }, 1);
    savePinnedSessions(['a', 'offline']);
    uiPreferences.requeue(uiPreferences.takeQueued());

    uiPreferences.applySnapshot({ revision: 7, values: { [PINNED]: ['a', 'remote'] } });

    expect(loadPinnedSessions()).toEqual(['a', 'remote', 'offline']);
    expect(uiPreferences.hasQueued()).toBe(true);
  });

  it('keeps the last server values in the legacy keys and drops the cache when the server stops serving preferences', () => {
    memStorage.set(STORAGE_KEYS.workspaceRecencyFloor, JSON.stringify({ legacy: 1 }));
    serverMode({ [UI_PREFERENCE_KEYS.sidebarWorkspaceRecencyFloor]: { server: 2 } });
    saveWorkspaceRecencyFloor({ server: 3 });

    uiPreferences.fallBackToLocal();
    uiPreferences.bind(SERVER);

    expect(uiPreferences.mode).toBe('local');
    expect(loadWorkspaceRecencyFloor()).toEqual({ server: 3 });
  });

  it('writes changes from other clients to the legacy keys so a downgraded app still shows them', () => {
    memStorage.set(STORAGE_KEYS.pinnedSessions, JSON.stringify(['old']));
    memStorage.set(STORAGE_KEYS.sidebarViewMode, 'flat');
    serverMode({ [PINNED]: ['a'], [UI_PREFERENCE_KEYS.onboardingCompleted]: true });

    uiPreferences.applyEvent(2, { [PINNED]: ['a', 'b'] });

    expect(memStorage.get(STORAGE_KEYS.pinnedSessions)).toBe('["a","b"]');
    expect(memStorage.get(STORAGE_KEYS.onboarded)).toBe('1');
    expect(memStorage.has(STORAGE_KEYS.sidebarViewMode)).toBe(false);
  });
});

describe('legacy values to import', () => {
  beforeEach(() => {
    memStorage.clear();
    uiPreferences.bind(SERVER);
  });

  it('converts raw local values to the server shapes and skips unknown ones', () => {
    memStorage.set(STORAGE_KEYS.onboarded, '1');
    memStorage.set(STORAGE_KEYS.sidebarViewMode, 'flat');
    memStorage.set(STORAGE_KEYS.pinnedOrder, JSON.stringify(['session:a', 'bogus', 'ws:b']));
    memStorage.set(STORAGE_KEYS.workspaceSort, 'sideways');
    memStorage.set(STORAGE_KEYS.permission, 'yolo');

    expect(legacyUiPreferenceValues()).toEqual({
      [UI_PREFERENCE_KEYS.onboardingCompleted]: true,
      [UI_PREFERENCE_KEYS.sidebarViewMode]: 'flat',
      [UI_PREFERENCE_KEYS.sidebarPinnedOrder]: ['session:a', 'ws:b'],
    });
  });
});
