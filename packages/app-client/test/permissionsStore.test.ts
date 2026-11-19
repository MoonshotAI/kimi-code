
import { beforeEach, describe, expect, it, vi } from 'vitest';

const memStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void memStorage.set(key, value),
  removeItem: (key: string) => void memStorage.delete(key),
  clear: () => memStorage.clear(),
});

import { STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { permissionsStore } from '../src/stores/permissions';
import { sessionsStore } from '../src/stores/sessions';

beforeEach(() => {
  memStorage.clear();
  permissionsStore().$reset();
  sessionsStore().setActiveSessionId(undefined);
});

describe('resolution chain', () => {
  it('an existing session with nothing known stays unknown (no default guess)', () => {
    expect(permissionsStore().forSession('s1')).toBeUndefined();
    expect(permissionsStore().forDraft()).toBe('manual');
  });

  it('a session with its own explicit pick wins over every default', () => {
    permissionsStore().pickInSession('s1', 'yolo');
    permissionsStore().setDaemonDefault('auto');
    expect(permissionsStore().forSession('s1')).toBe('yolo');
  });

  it('a session with only a daemon mirror reads the mirror', () => {
    permissionsStore().foldDaemonMode('s1', 'auto');
    expect(permissionsStore().forSession('s1')).toBe('auto');
  });

  it('without a Settings default the sticky pick is the DRAFT fallback only', () => {
    permissionsStore().pickInDraft('yolo');
    permissionsStore().enterDraft();
    expect(permissionsStore().forDraft()).toBe('yolo');
    expect(permissionsStore().forSession('unknown')).toBeUndefined();
  });
});

describe('new-session default recency (sticky vs Settings default)', () => {
  it('a pill pick owns new sessions until the Settings default changes again', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      permissionsStore().setDaemonDefault('auto');
      vi.setSystemTime(2_000);
      permissionsStore().pickInDraft('yolo');
      permissionsStore().enterDraft();
      expect(permissionsStore().forDraft()).toBe('yolo');
      vi.setSystemTime(3_000);
      permissionsStore().setDaemonDefault('manual');
      expect(permissionsStore().forDraft()).toBe('manual');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a re-loaded identical Settings default does not rejuvenate over the sticky pick', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      permissionsStore().setDaemonDefault('auto');
      vi.setSystemTime(2_000);
      permissionsStore().pickInDraft('yolo');
      permissionsStore().enterDraft();
      vi.setSystemTime(3_000);
      permissionsStore().setDaemonDefault('auto');
      expect(permissionsStore().forDraft()).toBe('yolo');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a Settings change made while this client was away ends the sticky claim at boot', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      permissionsStore().setDaemonDefault('auto');
      vi.setSystemTime(2_000);
      permissionsStore().pickInDraft('auto');
      permissionsStore().$reset();
      vi.setSystemTime(3_000);
      permissionsStore().setDaemonDefault('manual');
      permissionsStore().enterDraft();
      expect(permissionsStore().forDraft()).toBe('manual');
      expect(permissionsStore().stickyAt).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a default that APPEARED while away (previously unset) ends the sticky claim at boot', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      permissionsStore().setDaemonDefault(undefined);
      vi.setSystemTime(2_000);
      permissionsStore().pickInDraft('auto');
      permissionsStore().$reset();
      vi.setSystemTime(3_000);
      permissionsStore().setDaemonDefault('yolo');
      permissionsStore().enterDraft();
      expect(permissionsStore().forDraft()).toBe('yolo');
      expect(permissionsStore().stickyAt).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a Settings change ends the pick’s claim for good — across a restart', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      permissionsStore().setDaemonDefault('auto');
      vi.setSystemTime(2_000);
      permissionsStore().pickInDraft('auto');
      vi.setSystemTime(3_000);
      permissionsStore().setDaemonDefault('manual');
      expect(permissionsStore().forDraft()).toBe('auto');
      expect(permissionsStore().stickyAt).toBe(0);
      permissionsStore().enterDraft();
      expect(permissionsStore().forDraft()).toBe('manual');
      permissionsStore().$reset();
      permissionsStore().setDaemonDefault('manual');
      permissionsStore().enterDraft();
      expect(permissionsStore().forDraft()).toBe('manual');
    } finally {
      vi.useRealTimers();
    }
  });

  it('migrates a pre-upgrade pick (old key, no timestamp) as the oldest recorded pick', () => {
    localStorage.setItem(STORAGE_KEYS.permission, 'auto');
    permissionsStore().$reset();
    expect(permissionsStore().stickyAt).toBeGreaterThan(0);
    permissionsStore().setDaemonDefault('manual');
    permissionsStore().enterDraft();
    expect(permissionsStore().forDraft()).toBe('auto');
  });

  it('a pick made before a reload still owns new sessions after it', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000);
      permissionsStore().pickInDraft('yolo');
      permissionsStore().$reset();
      vi.setSystemTime(3_000);
      permissionsStore().setDaemonDefault('auto');
      permissionsStore().enterDraft();
      expect(permissionsStore().forDraft()).toBe('yolo');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('invalidated sticky is never a fallback', () => {
  it('a cleared Settings default does not resurrect a dead pick', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      permissionsStore().setDaemonDefault('yolo');
      vi.setSystemTime(2_000);
      permissionsStore().pickInDraft('auto');
      vi.setSystemTime(3_000);
      permissionsStore().setDaemonDefault('manual');
      expect(permissionsStore().stickyAt).toBe(0);
      permissionsStore().setDaemonDefault(undefined);
      permissionsStore().enterDraft();
      expect(permissionsStore().forDraft()).toBe('manual');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('per-session isolation (the bug this store fixes)', () => {
  it('a pick in one session does not move another session', () => {
    permissionsStore().pickInSession('s1', 'manual');
    permissionsStore().pickInSession('s2', 'auto');
    expect(permissionsStore().forSession('s1')).toBe('manual');
    expect(permissionsStore().forSession('s2')).toBe('auto');
  });

  it('a daemon fold writes only its own session', () => {
    permissionsStore().foldDaemonMode('s1', 'yolo');
    permissionsStore().foldDaemonMode('s2', 'manual');
    expect(permissionsStore().forSession('s1')).toBe('yolo');
    expect(permissionsStore().forSession('s2')).toBe('manual');
  });

  it('a later default change leaves a materialized session alone', () => {
    permissionsStore().setDaemonDefault('yolo');
    permissionsStore().materializeDraft('s1', permissionsStore().forDraftPrompt());
    expect(permissionsStore().forSession('s1')).toBe('yolo');
    permissionsStore().pickInSession('s2', 'auto');
    permissionsStore().setDaemonDefault('manual');
    expect(permissionsStore().forSession('s1')).toBe('yolo');
  });
});

describe('picks', () => {
  it('pickInSession writes the in-flight entry and persists the sticky default', () => {
    permissionsStore().pickInSession('s1', 'yolo');
    expect(permissionsStore().explicit['s1']).toBe('yolo');
    expect(permissionsStore().sticky).toBe('yolo');
    expect(localStorage.getItem(STORAGE_KEYS.permissionExplicit)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.permission)).toBe('yolo');
    expect(Number(localStorage.getItem(STORAGE_KEYS.permissionStickyAt))).toBeGreaterThan(0);
  });

  it('pickInDraft touches no session and no profile is owed', () => {
    permissionsStore().pickInDraft('auto');
    expect(permissionsStore().draftPick).toBe('auto');
    expect(permissionsStore().sticky).toBe('auto');
    expect(permissionsStore().explicit).toEqual({});
    expect(permissionsStore().modes).toEqual({});
  });

  it('enterDraft resets the draft pick but keeps the sticky default', () => {
    permissionsStore().pickInDraft('auto');
    permissionsStore().enterDraft();
    expect(permissionsStore().draftPick).toBeUndefined();
    expect(permissionsStore().forDraft()).toBe('auto');
  });

  it('materializeDraft pins the captured draft mode to the new session', () => {
    permissionsStore().pickInDraft('manual');
    const captured = permissionsStore().forDraftPrompt();
    permissionsStore().enterDraft();
    permissionsStore().pickInDraft('yolo');
    permissionsStore().materializeDraft('s1', captured);
    expect(permissionsStore().explicit['s1']).toBe('manual');
    expect(permissionsStore().draftPick).toBe('yolo');
  });

  it('materializeDraft never clobbers a pick made on the new session mid-creation', () => {
    const captured = permissionsStore().forDraftPrompt();
    permissionsStore().pickInSession('s1', 'manual');
    permissionsStore().materializeDraft('s1', captured);
    expect(permissionsStore().explicit['s1']).toBe('manual');
  });
});

describe('in-flight pick', () => {
  it('shows over the mirror until its write settles, then the mirror shows', () => {
    permissionsStore().foldDaemonMode('s1', 'manual');
    permissionsStore().pickInSession('s1', 'auto');
    const seq = permissionsStore().explicitSeqFor('s1');
    permissionsStore().foldDaemonMode('s1', 'manual');
    expect(permissionsStore().forSession('s1')).toBe('auto');
    permissionsStore().foldDaemonMode('s1', 'auto');
    permissionsStore().settleExplicit('s1', seq, true);
    expect(permissionsStore().explicit['s1']).toBeUndefined();
    expect(permissionsStore().forSession('s1')).toBe('auto');
  });

  it('a settled older write leaves a newer pick in flight', () => {
    permissionsStore().pickInSession('s1', 'auto');
    const older = permissionsStore().explicitSeqFor('s1');
    permissionsStore().pickInSession('s1', 'yolo');
    permissionsStore().settleExplicit('s1', older, true);
    expect(permissionsStore().forSession('s1')).toBe('yolo');
  });

  it('a failed write falls back to the mirror and ends its sticky claim', () => {
    permissionsStore().foldDaemonMode('s1', 'manual');
    permissionsStore().pickInSession('s1', 'auto');
    permissionsStore().settleExplicit('s1', permissionsStore().explicitSeqFor('s1'), false);
    expect(permissionsStore().forSession('s1')).toBe('manual');
    expect(permissionsStore().stickyAt).toBe(0);
  });
});

describe('clearSession', () => {
  it('drops the session’s explicit and mirror entries', () => {
    permissionsStore().pickInSession('s1', 'auto');
    permissionsStore().foldDaemonMode('s1', 'yolo');
    permissionsStore().clearSession('s1');
    expect(permissionsStore().explicit['s1']).toBeUndefined();
    expect(permissionsStore().modes['s1']).toBeUndefined();
    expect(localStorage.getItem(STORAGE_KEYS.permissionBySession)).toBe('{}');
  });
});

describe('forActive', () => {
  it('reads the draft in draft-land and the session entry in a session', () => {
    sessionsStore().setActiveSessionId(undefined);
    expect(permissionsStore().forActive()).toBe('manual');
    permissionsStore().pickInSession('s1', 'yolo');
    sessionsStore().setActiveSessionId('s1');
    expect(permissionsStore().forActive()).toBe('yolo');
    sessionsStore().setActiveSessionId('s2');
    expect(permissionsStore().forActive()).toBeUndefined();
  });
});

describe('persistence', () => {
  it('reloads the mirror and the sticky pick but not in-flight picks', () => {
    permissionsStore().pickInSession('s1', 'yolo');
    permissionsStore().foldDaemonMode('s2', 'auto');
    permissionsStore().$reset();
    expect(permissionsStore().explicit['s1']).toBeUndefined();
    expect(permissionsStore().modes['s2']).toBe('auto');
    expect(permissionsStore().sticky).toBe('yolo');
    expect(permissionsStore().stickyAt).toBeGreaterThan(0);
  });

  it('drops entries this build does not recognize instead of leaking them', () => {
    localStorage.setItem(STORAGE_KEYS.permissionBySession, JSON.stringify({ s2: 'turbo' }));
    permissionsStore().$reset();
    expect(permissionsStore().modes['s2']).toBeUndefined();
  });
});
