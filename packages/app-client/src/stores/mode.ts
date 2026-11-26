import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import type { ThinkingLevel } from '@moonshot-ai/app-core/api';
import {
  markPlanPending,
  markSwarmPending,
  markTowerPending,
  safeGetString,
  safeRemove,
  safeSetString,
  STORAGE_KEYS,
} from '@moonshot-ai/app-core/lib';
import type { PersistSessionProfilePatch } from '../client/useModelProviderState';
import { clientPinia } from './pinia';
import { sessionsStore } from './sessions';

safeRemove(STORAGE_KEYS.thinking);

export interface ModeHooks {
  persistSessionProfile: (
    patch: PersistSessionProfilePatch,
    sessionId?: string,
  ) => Promise<boolean>;
  notifySwarmEnabled?: () => void;
}

let modeHooks: ModeHooks | null = null;

export function setModeHooks(next: ModeHooks | null): void {
  modeHooks = next;
}

function loadModeMapFromStorage(key: string): Record<string, boolean> {
  const raw = safeGetString(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true) out[id] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function saveModeMapToStorage(key: string, map: Record<string, boolean>): void {
  try {
    const out: Record<string, true> = {};
    for (const [id, value] of Object.entries(map)) {
      if (value) out[id] = true;
    }
    safeSetString(key, JSON.stringify(out));
  } catch {
  }
}

export const useModeStore = defineStore('kimi.mode', () => {
  const thinking = ref<ThinkingLevel | undefined>(undefined);
  const draftThinkingExplicit = ref(false);
  const thinkingBySession = ref<Record<string, ThinkingLevel>>({});
  const pendingThinkingBySession = ref<Record<string, number>>({});
  const planModeBySession = ref<Record<string, boolean>>(loadModeMapFromStorage(STORAGE_KEYS.planMode));
  const planArmedBySession = ref<Record<string, boolean>>(loadModeMapFromStorage(STORAGE_KEYS.planArmed));
  const pendingPlanBySession = ref<Record<string, number>>({});
  const swarmModeBySession = ref<Record<string, boolean>>(loadModeMapFromStorage(STORAGE_KEYS.swarmMode));
  const pendingSwarmBySession = ref<Record<string, number>>({});
  const towerModeBySession = ref<Record<string, boolean>>(loadModeMapFromStorage(STORAGE_KEYS.towerMode));
  const pendingTowerBySession = ref<Record<string, number>>({});
  const goalModeBySession = ref<Record<string, boolean>>(loadModeMapFromStorage(STORAGE_KEYS.goalMode));
  const draftModes = reactive<{ planMode: boolean; swarmMode: boolean; towerMode: boolean; towerBase?: string; goalMode: boolean }>({
    planMode: false,
    swarmMode: false,
    towerMode: false,
    towerBase: undefined,
    goalMode: false,
  });

  const planMode = computed<boolean>(() => {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return draftModes.planMode;
    return planModeBySession.value[sid] ?? false;
  });
  const planArmed = computed<boolean>(() => {
    const sid = sessionsStore().activeSessionId;
    return sid ? (planArmedBySession.value[sid] ?? false) : draftModes.planMode;
  });
  const swarmMode = computed<boolean>(() => {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return draftModes.swarmMode;
    return swarmModeBySession.value[sid] ?? false;
  });
  const towerMode = computed<boolean>(() => {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return draftModes.towerMode;
    return towerModeBySession.value[sid] ?? false;
  });
  const goalMode = computed<boolean>(() => {
    const sid = sessionsStore().activeSessionId;
    return sid ? (goalModeBySession.value[sid] ?? false) : draftModes.goalMode;
  });

  function savePlanModeToStorage(): void {
    saveModeMapToStorage(STORAGE_KEYS.planArmed, planArmedBySession.value);
  }

  function saveSwarmModeToStorage(): void {
    saveModeMapToStorage(STORAGE_KEYS.swarmMode, swarmModeBySession.value);
  }

  function saveTowerModeToStorage(): void {
    saveModeMapToStorage(STORAGE_KEYS.towerMode, towerModeBySession.value);
  }

  function saveGoalModeToStorage(): void {
    saveModeMapToStorage(STORAGE_KEYS.goalMode, goalModeBySession.value);
  }

  function setPlanMode(on: boolean): void {
    const sid = sessionsStore().activeSessionId;
    if (sid) {
      if (on) void setTowerMode(false);
      planArmedBySession.value = { ...planArmedBySession.value, [sid]: on };
      savePlanModeToStorage();
      if (!on && (planModeBySession.value[sid] ?? false)) {
        planModeBySession.value = { ...planModeBySession.value, [sid]: false };
        markPlanPending({ pendingPlanBySession: pendingPlanBySession.value }, sid);
        void modeHooks?.persistSessionProfile({ planMode: false }, sid);
      }
    } else {
      if (on && draftModes.towerMode) draftModes.towerMode = false;
      draftModes.planMode = on;
    }
  }

  function setSwarmMode(on: boolean): void {
    const sid = sessionsStore().activeSessionId;
    if (sid) {
      if (on) {
        towerModeBySession.value = { ...towerModeBySession.value, [sid]: false };
        saveTowerModeToStorage();
        markTowerPending({ pendingTowerBySession: pendingTowerBySession.value }, sid);
      }
      swarmModeBySession.value = { ...swarmModeBySession.value, [sid]: on };
      saveSwarmModeToStorage();
      markSwarmPending({ pendingSwarmBySession: pendingSwarmBySession.value }, sid);
      void modeHooks?.persistSessionProfile({ swarmMode: on, towerMode: on ? false : undefined });
    } else {
      if (on && draftModes.towerMode) draftModes.towerMode = false;
      draftModes.swarmMode = on;
    }
  }

  function setTowerMode(on: boolean, base?: string): Promise<boolean> {
    const sid = sessionsStore().activeSessionId;
    if (sid) {
      const armedGoal = on && (goalModeBySession.value[sid] ?? false);
      if (on) {
        swarmModeBySession.value = { ...swarmModeBySession.value, [sid]: false };
        saveSwarmModeToStorage();
        markSwarmPending({ pendingSwarmBySession: pendingSwarmBySession.value }, sid);
        if (planArmedBySession.value[sid] ?? false) {
          planArmedBySession.value = { ...planArmedBySession.value, [sid]: false };
        }
        planModeBySession.value = { ...planModeBySession.value, [sid]: false };
        savePlanModeToStorage();
        markPlanPending({ pendingPlanBySession: pendingPlanBySession.value }, sid);
        if (armedGoal) {
          goalModeBySession.value = { ...goalModeBySession.value, [sid]: false };
          saveGoalModeToStorage();
        }
      }
      towerModeBySession.value = { ...towerModeBySession.value, [sid]: on };
      saveTowerModeToStorage();
      markTowerPending({ pendingTowerBySession: pendingTowerBySession.value }, sid);
      const persisted =
        modeHooks?.persistSessionProfile(
          {
            towerMode: on,
            towerBase: on ? base : undefined,
            swarmMode: on ? false : undefined,
            planMode: on ? false : undefined,
          },
          sid,
        ) ?? Promise.resolve(true);
      if (!armedGoal) return persisted;
      const restoreArmedGoal = (): void => {
        goalModeBySession.value = { ...goalModeBySession.value, [sid]: true };
        saveGoalModeToStorage();
      };
      return persisted.then(
        (ok) => {
          if (!ok) restoreArmedGoal();
          return ok;
        },
        (error: unknown) => {
          restoreArmedGoal();
          throw error;
        },
      );
    }
    if (on && draftModes.swarmMode) draftModes.swarmMode = false;
    if (on && draftModes.planMode) draftModes.planMode = false;
    if (on && draftModes.goalMode) draftModes.goalMode = false;
    draftModes.towerMode = on;
    draftModes.towerBase = on ? base : undefined;
    return Promise.resolve(true);
  }

  function setGoalMode(on: boolean): void {
    const sid = sessionsStore().activeSessionId;
    if (sid) {
      if (on && (towerModeBySession.value[sid] ?? false)) void setTowerMode(false);
      goalModeBySession.value = { ...goalModeBySession.value, [sid]: on };
      saveGoalModeToStorage();
    } else {
      if (on && draftModes.towerMode) {
        draftModes.towerMode = false;
        draftModes.towerBase = undefined;
      }
      draftModes.goalMode = on;
    }
  }

  function togglePlanMode(): void {
    const sid = sessionsStore().activeSessionId;
    const current = sid
      ? (planArmedBySession.value[sid] ?? false) || (planModeBySession.value[sid] ?? false)
      : draftModes.planMode;
    setPlanMode(!current);
  }

  function enableSwarmMode(): void {
    const sid = sessionsStore().activeSessionId;
    const current = sid ? (swarmModeBySession.value[sid] ?? false) : draftModes.swarmMode;
    if (current) return;
    setSwarmMode(true);
    modeHooks?.notifySwarmEnabled?.();
  }

  function toggleSwarmMode(): void {
    const sid = sessionsStore().activeSessionId;
    const current = sid ? (swarmModeBySession.value[sid] ?? false) : draftModes.swarmMode;
    if (current) {
      setSwarmMode(false);
      return;
    }
    enableSwarmMode();
  }

  function toggleGoalMode(): void {
    const sid = sessionsStore().activeSessionId;
    const current = sid ? (goalModeBySession.value[sid] ?? false) : draftModes.goalMode;
    setGoalMode(!current);
  }

  function toggleTowerMode(): void {
    const sid = sessionsStore().activeSessionId;
    const current = sid ? (towerModeBySession.value[sid] ?? false) : draftModes.towerMode;
    void setTowerMode(!current);
  }

  function resetMode(): void {
    thinking.value = undefined;
    draftThinkingExplicit.value = false;
    thinkingBySession.value = {};
    pendingThinkingBySession.value = {};
    planModeBySession.value = {};
    planArmedBySession.value = {};
    pendingPlanBySession.value = {};
    swarmModeBySession.value = {};
    pendingSwarmBySession.value = {};
    towerModeBySession.value = {};
    pendingTowerBySession.value = {};
    goalModeBySession.value = {};
    draftModes.planMode = false;
    draftModes.swarmMode = false;
    draftModes.towerMode = false;
    draftModes.towerBase = undefined;
    draftModes.goalMode = false;
  }

  return {
    thinking,
    draftThinkingExplicit,
    thinkingBySession,
    pendingThinkingBySession,
    planModeBySession,
    planArmedBySession,
    pendingPlanBySession,
    swarmModeBySession,
    pendingSwarmBySession,
    towerModeBySession,
    pendingTowerBySession,
    goalModeBySession,
    draftModes,
    planMode,
    planArmed,
    swarmMode,
    towerMode,
    goalMode,
    savePlanModeToStorage,
    saveSwarmModeToStorage,
    saveTowerModeToStorage,
    saveGoalModeToStorage,
    setPlanMode,
    setSwarmMode,
    setTowerMode,
    setGoalMode,
    enableSwarmMode,
    togglePlanMode,
    toggleSwarmMode,
    toggleGoalMode,
    toggleTowerMode,
    resetMode,
  };
});

export function modeStore() {
  return useModeStore(clientPinia);
}
