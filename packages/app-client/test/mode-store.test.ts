import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia } from 'pinia';
import { STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { modeStore, setModeHooks, useModeStore } from '../src/stores/mode';
import { sessionsStore } from '../src/stores/sessions';

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(data.keys()).at(index) ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, String(value));
    },
  };
}

function installStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

beforeEach(() => {
  installStorage(createMemoryStorage());
  modeStore().resetMode();
  sessionsStore().setActiveSessionId(undefined);
});

afterEach(() => {
  setModeHooks(null);
});

describe('mode store persistence', () => {
  it('loads only true-valued entries from storage on creation', () => {
    localStorage.setItem(STORAGE_KEYS.planArmed, JSON.stringify({ a: true, b: false, c: 1, d: 'true' }));
    const store = useModeStore(createPinia());
    expect(store.planArmedBySession).toEqual({ a: true });
  });

  it('treats malformed storage payloads as empty', () => {
    localStorage.setItem(STORAGE_KEYS.swarmMode, 'not-json');
    localStorage.setItem(STORAGE_KEYS.goalMode, JSON.stringify([1, 2]));
    const store = useModeStore(createPinia());
    expect(store.swarmModeBySession).toEqual({});
    expect(store.goalModeBySession).toEqual({});
  });

  it('saves only truthy entries back to storage', () => {
    const store = modeStore();
    store.planArmedBySession = { a: true, b: false };
    store.savePlanModeToStorage();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.planArmed)!)).toEqual({ a: true });
  });
});

describe('mode store setPlanMode', () => {
  it('arms locally without a plan write, disarms tower, and persists the armed map', () => {
    sessionsStore().setActiveSessionId('sess_1');
    const persist = vi.fn().mockResolvedValue(true);
    setModeHooks({ persistSessionProfile: persist });

    modeStore().setPlanMode(true);

    expect(modeStore().planArmedBySession.sess_1).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.planArmed)!)).toEqual({ sess_1: true });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ towerMode: false }, 'sess_1');
  });

  it('disarming a live plan mode clears it, marks pending, and writes the profile', () => {
    sessionsStore().setActiveSessionId('sess_1');
    const persist = vi.fn().mockResolvedValue(true);
    setModeHooks({ persistSessionProfile: persist });
    modeStore().planModeBySession = { sess_1: true };

    modeStore().setPlanMode(false);

    expect(modeStore().planArmedBySession.sess_1).toBe(false);
    expect(modeStore().planModeBySession.sess_1).toBe(false);
    expect(modeStore().pendingPlanBySession.sess_1).toBeTypeOf('number');
    expect(persist).toHaveBeenCalledWith({ planMode: false }, 'sess_1');
  });

  it('disarming without a live plan mode skips the profile write', () => {
    sessionsStore().setActiveSessionId('sess_1');
    const persist = vi.fn().mockResolvedValue(true);
    setModeHooks({ persistSessionProfile: persist });

    modeStore().setPlanMode(false);

    expect(persist).not.toHaveBeenCalled();
    expect(modeStore().pendingPlanBySession.sess_1).toBeUndefined();
  });

  it('stages the draft when no session is active', () => {
    modeStore().setPlanMode(true);
    expect(modeStore().draftModes.planMode).toBe(true);
    expect(modeStore().planArmedBySession).toEqual({});
  });
});

describe('mode store setSwarmMode', () => {
  it('writes the mode, marks pending, and persists the profile', () => {
    sessionsStore().setActiveSessionId('sess_1');
    const persist = vi.fn().mockResolvedValue(true);
    setModeHooks({ persistSessionProfile: persist });

    modeStore().setSwarmMode(true);

    expect(modeStore().swarmModeBySession.sess_1).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.swarmMode)!)).toEqual({ sess_1: true });
    expect(modeStore().pendingSwarmBySession.sess_1).toBeTypeOf('number');
    expect(persist).toHaveBeenCalledWith({ swarmMode: true, towerMode: false });
  });

  it('stages the draft when no session is active', () => {
    modeStore().setSwarmMode(true);
    expect(modeStore().draftModes.swarmMode).toBe(true);
    expect(modeStore().swarmModeBySession).toEqual({});
  });
});

describe('mode store enableSwarmMode', () => {
  function hooks() {
    const persistSessionProfile = vi.fn().mockResolvedValue(true);
    const notifySwarmEnabled = vi.fn();
    setModeHooks({ persistSessionProfile, notifySwarmEnabled });
    return { persistSessionProfile, notifySwarmEnabled };
  }

  beforeEach(() => {
    sessionsStore().setActiveSessionId('sess_1');
  });

  it('turns swarm on without asking and shows the usage notice', () => {
    const { persistSessionProfile, notifySwarmEnabled } = hooks();

    modeStore().enableSwarmMode();

    expect(modeStore().swarmModeBySession.sess_1).toBe(true);
    expect(persistSessionProfile).toHaveBeenCalledWith({ swarmMode: true, towerMode: false });
    expect(notifySwarmEnabled).toHaveBeenCalledOnce();
  });

  it('shows the usage notice when a draft turns swarm on', () => {
    sessionsStore().setActiveSessionId(undefined);
    const { notifySwarmEnabled } = hooks();

    modeStore().enableSwarmMode();

    expect(modeStore().draftModes.swarmMode).toBe(true);
    expect(notifySwarmEnabled).toHaveBeenCalledOnce();
  });

  it('does nothing when swarm is already on', () => {
    const { persistSessionProfile, notifySwarmEnabled } = hooks();
    modeStore().swarmModeBySession = { sess_1: true };

    modeStore().enableSwarmMode();

    expect(persistSessionProfile).not.toHaveBeenCalled();
    expect(notifySwarmEnabled).not.toHaveBeenCalled();
  });

  it('turns swarm off without a notice', () => {
    const { notifySwarmEnabled } = hooks();
    modeStore().swarmModeBySession = { sess_1: true };

    modeStore().toggleSwarmMode();

    expect(modeStore().swarmModeBySession.sess_1).toBe(false);
    expect(notifySwarmEnabled).not.toHaveBeenCalled();
  });

  it('turns swarm on from the toggle with the same notice', () => {
    const { notifySwarmEnabled } = hooks();

    modeStore().toggleSwarmMode();

    expect(modeStore().swarmModeBySession.sess_1).toBe(true);
    expect(notifySwarmEnabled).toHaveBeenCalledOnce();
  });
});

describe('mode store setGoalMode', () => {
  it('writes the mode and persists without a profile write', () => {
    sessionsStore().setActiveSessionId('sess_1');
    const persist = vi.fn().mockResolvedValue(true);
    setModeHooks({ persistSessionProfile: persist });

    modeStore().setGoalMode(true);

    expect(modeStore().goalModeBySession.sess_1).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.goalMode)!)).toEqual({ sess_1: true });
    expect(persist).not.toHaveBeenCalled();
  });

  it('stages the draft when no session is active', () => {
    modeStore().setGoalMode(true);
    expect(modeStore().draftModes.goalMode).toBe(true);
  });

  it('disarms an active tower mode when enabling goal mode for a session', () => {
    sessionsStore().setActiveSessionId('sess_1');
    const persist = vi.fn().mockResolvedValue(true);
    setModeHooks({ persistSessionProfile: persist });
    modeStore().towerModeBySession = { sess_1: true };

    modeStore().setGoalMode(true);

    expect(modeStore().goalModeBySession.sess_1).toBe(true);
    expect(modeStore().towerModeBySession.sess_1).toBe(false);
    expect(persist).toHaveBeenCalledWith({ towerMode: false }, 'sess_1');
  });

  it('disarms draft tower mode when enabling draft goal mode', () => {
    modeStore().draftModes.towerMode = true;
    modeStore().draftModes.towerBase = 'main';

    modeStore().setGoalMode(true);

    expect(modeStore().draftModes.goalMode).toBe(true);
    expect(modeStore().draftModes.towerMode).toBe(false);
    expect(modeStore().draftModes.towerBase).toBeUndefined();
  });
});

describe('mode store setTowerMode', () => {
  it('disarms plan, swarm, and goal modes when enabling tower mode for a session', async () => {
    sessionsStore().setActiveSessionId('sess_1');
    const persist = vi.fn().mockResolvedValue(true);
    setModeHooks({ persistSessionProfile: persist });
    modeStore().planArmedBySession = { sess_1: true };
    modeStore().planModeBySession = { sess_1: true };
    modeStore().swarmModeBySession = { sess_1: true };
    modeStore().goalModeBySession = { sess_1: true };

    await modeStore().setTowerMode(true);

    expect(modeStore().towerModeBySession.sess_1).toBe(true);
    expect(modeStore().planArmedBySession.sess_1).toBe(false);
    expect(modeStore().planModeBySession.sess_1).toBe(false);
    expect(modeStore().swarmModeBySession.sess_1).toBe(false);
    expect(modeStore().goalModeBySession.sess_1).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.goalMode)!)).toEqual({});
    expect(persist).toHaveBeenCalledWith(
      { towerMode: true, towerBase: undefined, swarmMode: false, planMode: false },
      'sess_1',
    );
  });

  it('restores armed goal mode when enabling tower mode fails for a session', async () => {
    sessionsStore().setActiveSessionId('sess_1');
    const persist = vi.fn().mockImplementation(async () => {
      modeStore().towerModeBySession = { sess_1: false };
      return false;
    });
    setModeHooks({ persistSessionProfile: persist });
    modeStore().goalModeBySession = { sess_1: true };
    modeStore().saveGoalModeToStorage();

    const ok = await modeStore().setTowerMode(true);

    expect(ok).toBe(false);
    expect(modeStore().goalModeBySession.sess_1).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.goalMode)!)).toEqual({ sess_1: true });
  });

  it('restores armed goal mode when enabling tower mode rejects for a session', async () => {
    sessionsStore().setActiveSessionId('sess_1');
    const persist = vi.fn().mockImplementation(async () => {
      modeStore().towerModeBySession = { sess_1: false };
      throw new Error('network down');
    });
    setModeHooks({ persistSessionProfile: persist });
    modeStore().goalModeBySession = { sess_1: true };
    modeStore().saveGoalModeToStorage();

    await expect(modeStore().setTowerMode(true)).rejects.toThrow('network down');

    expect(modeStore().goalModeBySession.sess_1).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.goalMode)!)).toEqual({ sess_1: true });
  });

  it('does not re-arm goal when tower is active but an earlier profile write failed', async () => {
    sessionsStore().setActiveSessionId('sess_1');
    const persist = vi.fn().mockResolvedValue(false);
    setModeHooks({ persistSessionProfile: persist });
    modeStore().goalModeBySession = { sess_1: true };
    modeStore().saveGoalModeToStorage();

    const ok = await modeStore().setTowerMode(true);

    expect(ok).toBe(false);
    expect(modeStore().towerModeBySession.sess_1).toBe(true);
    expect(modeStore().goalModeBySession.sess_1).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.goalMode)!)).toEqual({});
  });

  it('disarms draft plan, swarm, and goal modes when enabling draft tower mode', async () => {
    modeStore().draftModes.planMode = true;
    modeStore().draftModes.swarmMode = true;
    modeStore().draftModes.goalMode = true;

    await modeStore().setTowerMode(true);

    expect(modeStore().draftModes).toEqual({
      planMode: false,
      swarmMode: false,
      towerMode: true,
      towerBase: undefined,
      goalMode: false,
    });
  });
});

describe('mode store projections', () => {
  it('falls back to the draft modes when no session is active', () => {
    modeStore().draftModes.planMode = true;
    modeStore().draftModes.swarmMode = true;
    modeStore().draftModes.goalMode = true;
    expect(modeStore().planMode).toBe(true);
    expect(modeStore().planArmed).toBe(true);
    expect(modeStore().swarmMode).toBe(true);
    expect(modeStore().goalMode).toBe(true);
  });

  it('reads the per-session maps when a session is active', () => {
    sessionsStore().setActiveSessionId('sess_1');
    modeStore().planModeBySession = { sess_1: true };
    modeStore().planArmedBySession = { sess_1: true };
    modeStore().swarmModeBySession = { sess_1: false };
    modeStore().goalModeBySession = { sess_1: true };
    modeStore().draftModes.swarmMode = true;

    expect(modeStore().planMode).toBe(true);
    expect(modeStore().planArmed).toBe(true);
    expect(modeStore().swarmMode).toBe(false);
    expect(modeStore().goalMode).toBe(true);
  });
});

describe('mode store resetMode', () => {
  it('restores the initial state', () => {
    sessionsStore().setActiveSessionId('sess_1');
    const store = modeStore();
    store.thinking = 'high';
    store.draftThinkingExplicit = true;
    store.thinkingBySession = { sess_1: 'high' };
    store.pendingThinkingBySession = { sess_1: 1 };
    store.planModeBySession = { sess_1: true };
    store.planArmedBySession = { sess_1: true };
    store.pendingPlanBySession = { sess_1: 1 };
    store.swarmModeBySession = { sess_1: true };
    store.pendingSwarmBySession = { sess_1: 1 };
    store.towerModeBySession = { sess_1: true };
    store.pendingTowerBySession = { sess_1: 1 };
    store.goalModeBySession = { sess_1: true };
    store.draftModes.planMode = true;

    store.resetMode();

    expect(store.thinking).toBeUndefined();
    expect(store.draftThinkingExplicit).toBe(false);
    expect(store.thinkingBySession).toEqual({});
    expect(store.pendingThinkingBySession).toEqual({});
    expect(store.planModeBySession).toEqual({});
    expect(store.planArmedBySession).toEqual({});
    expect(store.pendingPlanBySession).toEqual({});
    expect(store.swarmModeBySession).toEqual({});
    expect(store.pendingSwarmBySession).toEqual({});
    expect(store.towerModeBySession).toEqual({});
    expect(store.pendingTowerBySession).toEqual({});
    expect(store.goalModeBySession).toEqual({});
    expect(store.draftModes).toEqual({ planMode: false, swarmMode: false, towerMode: false, towerBase: undefined, goalMode: false });
  });
});
