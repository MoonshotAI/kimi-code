import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { PermissionMode } from '@moonshot-ai/app-core/client/types';
import {
  loadPermissionBySession,
  loadStickyPermission,
  loadStickyPermissionAt,
  permissionModeFromConfig,
  savePermissionBySession,
  saveStickyPermission,
  saveStickyPermissionAt,
} from '@moonshot-ai/app-core/lib';
import { safeGetString, safeRemove, safeSetString, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { sessionsStore } from './sessions';
import { clientPinia } from './pinia';
import type { PersistSessionProfilePatch } from '../client/useModelProviderState';

safeRemove(STORAGE_KEYS.permissionExplicit);

export interface PermissionsHooks {
  persistSessionProfile: (
    patch: PersistSessionProfilePatch,
    sessionId?: string,
  ) => Promise<boolean>;
}

let permissionsHooks: PermissionsHooks | null = null;

export function setPermissionsHooks(next: PermissionsHooks | null): void {
  permissionsHooks = next;
}

export const usePermissionsStore = defineStore('kimi.permissions', () => {
  const explicit = ref<Record<string, PermissionMode>>({});
  const explicitSeq = ref<Record<string, number>>({});
  let explicitWriteSeq = 0;
  const modes = ref<Record<string, PermissionMode>>(loadPermissionBySession());
  const sticky = ref<PermissionMode>(loadStickyPermission());
  const stickyAt = ref<number>(loadStickyPermissionAt());
  const stickySeq = ref(0);
  const daemonDefault = ref<PermissionMode | undefined>(undefined);
  const daemonDefaultAt = ref(0);
  const daemonDefaultSeen = ref(false);
  const runStartedAt = Date.now();
  const sessionTeardownGen = ref<Record<string, number>>({});
  const sessionTeardownGenOrder: string[] = [];
  const SESSION_TEARDOWN_GEN_CAP = 200;
  const submitPrepInFlightBySid = new Map<string, number>();
  function sessionTeardownGenFor(sid: string): number {
    return sessionTeardownGen.value[sid] ?? 0;
  }
  function noteSubmitPrepStart(sid: string): void {
    submitPrepInFlightBySid.set(sid, (submitPrepInFlightBySid.get(sid) ?? 0) + 1);
  }
  function noteSubmitPrepEnd(sid: string): void {
    const remaining = (submitPrepInFlightBySid.get(sid) ?? 1) - 1;
    if (remaining <= 0) submitPrepInFlightBySid.delete(sid);
    else submitPrepInFlightBySid.set(sid, remaining);
  }
  const draftPick = ref<PermissionMode | undefined>(undefined);
  const observedDaemonDefault = ref<PermissionMode | null | undefined>(
    (() => {
      const raw = safeGetString(STORAGE_KEYS.permissionDaemonDefault);
      if (raw === 'none') return null;
      return permissionModeFromConfig(raw) ?? (raw === null ? undefined : undefined);
    })(),
  );

  const resolvedDefault = computed<PermissionMode>(() => {
    if (stickyAt.value > 0 && stickyAt.value >= daemonDefaultAt.value) return sticky.value;
    return daemonDefault.value ?? 'manual';
  });

  function forSession(sid: string): PermissionMode | undefined {
    return explicit.value[sid] ?? modes.value[sid];
  }

  function forDraft(): PermissionMode {
    return draftPick.value ?? resolvedDefault.value;
  }

  function forDraftPrompt(): PermissionMode | undefined {
    if (draftPick.value !== undefined) return draftPick.value;
    if (stickyAt.value >= runStartedAt) return sticky.value;
    if (!daemonDefaultSeen.value) return undefined;
    if (stickyAt.value > 0 && stickyAt.value >= daemonDefaultAt.value) return sticky.value;
    return daemonDefault.value ?? 'manual';
  }

  function forActive(): PermissionMode | undefined {
    const sid = sessionsStore().activeSessionId;
    return sid === undefined ? forDraft() : forSession(sid);
  }

  function setSticky(mode: PermissionMode): void {
    sticky.value = mode;
    stickyAt.value = Date.now();
    saveStickyPermission(mode);
    saveStickyPermissionAt(stickyAt.value);
  }

  function beginExplicitWrite(sid: string, mode: PermissionMode): number {
    const seq = ++explicitWriteSeq;
    explicit.value = { ...explicit.value, [sid]: mode };
    explicitSeq.value = { ...explicitSeq.value, [sid]: seq };
    return seq;
  }

  function pickInSession(sid: string, mode: PermissionMode): void {
    stickySeq.value = beginExplicitWrite(sid, mode);
    setSticky(mode);
  }

  function pickInDraft(mode: PermissionMode): void {
    draftPick.value = mode;
    setSticky(mode);
    stickySeq.value = 0;
  }

  function setPermission(mode: PermissionMode): void {
    const sid = sessionsStore().activeSessionId;
    if (sid === undefined) {
      pickInDraft(mode);
      return;
    }
    pickInSession(sid, mode);
    void permissionsHooks?.persistSessionProfile({ permissionMode: mode });
  }

  const draftGeneration = ref(0);
  function enterDraft(): void {
    draftPick.value = undefined;
    draftGeneration.value += 1;
  }

  function materializeDraft(sid: string, mode: PermissionMode | undefined): void {
    if (mode === undefined || explicit.value[sid] !== undefined) return;
    beginExplicitWrite(sid, mode);
  }

  function explicitSeqFor(sid: string): number | undefined {
    return explicitSeq.value[sid];
  }

  function settleExplicit(sid: string, seq: number | undefined, ok: boolean): void {
    if (seq === undefined || explicitSeq.value[sid] !== seq) return;
    const next = { ...explicit.value };
    delete next[sid];
    explicit.value = next;
    const nextSeq = { ...explicitSeq.value };
    delete nextSeq[sid];
    explicitSeq.value = nextSeq;
    if (!ok && stickySeq.value === seq) {
      stickyAt.value = 0;
      saveStickyPermissionAt(0);
      stickySeq.value = 0;
    }
  }

  function foldDaemonMode(sid: string, mode: PermissionMode): void {
    if (modes.value[sid] === mode) return;
    modes.value = { ...modes.value, [sid]: mode };
    savePermissionBySession(modes.value);
  }

  function pruneSessions(liveSids: ReadonlySet<string>): void {
    const known = new Set<string>([
      ...Object.keys(explicit.value),
      ...Object.keys(modes.value),
      ...submitPrepInFlightBySid.keys(),
    ]);
    for (const sid of known) {
      if (!liveSids.has(sid)) clearSessionRuntime(sid);
    }
  }

  function clearSessionRuntime(sid: string): void {
    sessionTeardownGen.value = {
      ...sessionTeardownGen.value,
      [sid]: (sessionTeardownGen.value[sid] ?? 0) + 1,
    };
    const orderIdx = sessionTeardownGenOrder.indexOf(sid);
    if (orderIdx !== -1) sessionTeardownGenOrder.splice(orderIdx, 1);
    sessionTeardownGenOrder.push(sid);
    while (sessionTeardownGenOrder.length > SESSION_TEARDOWN_GEN_CAP) {
      const keep: string[] = [];
      const unguarded: string[] = [];
      for (const entry of sessionTeardownGenOrder) {
        if ((submitPrepInFlightBySid.get(entry) ?? 0) > 0) keep.push(entry);
        else unguarded.push(entry);
      }
      const overflow = sessionTeardownGenOrder.length - SESSION_TEARDOWN_GEN_CAP;
      const evicting = unguarded.slice(0, overflow);
      if (evicting.length === 0) break;
      const evictSet = new Set(evicting);
      const nextGen = { ...sessionTeardownGen.value };
      for (const entry of evicting) delete nextGen[entry];
      sessionTeardownGen.value = nextGen;
      sessionTeardownGenOrder.length = 0;
      sessionTeardownGenOrder.push(
        ...[...keep, ...unguarded.slice(evicting.length)].filter((entry) => !evictSet.has(entry)),
      );
    }
    if (explicit.value[sid] !== undefined) {
      const next = { ...explicit.value };
      delete next[sid];
      explicit.value = next;
    }
    if (explicitSeq.value[sid] !== undefined) {
      const next = { ...explicitSeq.value };
      delete next[sid];
      explicitSeq.value = next;
    }
  }

  function clearSession(sid: string): void {
    clearSessionRuntime(sid);
    if (modes.value[sid] !== undefined) {
      const next = { ...modes.value };
      delete next[sid];
      modes.value = next;
      savePermissionBySession(modes.value);
    }
  }

  function setDaemonDefault(mode: PermissionMode | undefined): void {
    if (!daemonDefaultSeen.value) {
      if (
        observedDaemonDefault.value !== undefined &&
        mode !== (observedDaemonDefault.value ?? undefined) &&
        stickyAt.value < runStartedAt
      ) {
        stickyAt.value = 0;
        saveStickyPermissionAt(0);
      }
    } else if (mode !== daemonDefault.value) {
      daemonDefaultAt.value = Date.now();
      stickyAt.value = 0;
      saveStickyPermissionAt(0);
    }
    daemonDefaultSeen.value = true;
    daemonDefault.value = mode;
    observedDaemonDefault.value = mode ?? null;
    safeSetString(STORAGE_KEYS.permissionDaemonDefault, mode ?? 'none');
  }

  function $reset(): void {
    explicit.value = {};
    explicitSeq.value = {};
    modes.value = loadPermissionBySession();
    sticky.value = loadStickyPermission();
    stickyAt.value = loadStickyPermissionAt();
    daemonDefault.value = undefined;
    daemonDefaultAt.value = 0;
    daemonDefaultSeen.value = false;
    stickySeq.value = 0;
    draftPick.value = undefined;
    sessionTeardownGen.value = {};
    sessionTeardownGenOrder.length = 0;
    submitPrepInFlightBySid.clear();
    {
      const raw = safeGetString(STORAGE_KEYS.permissionDaemonDefault);
      observedDaemonDefault.value = raw === 'none' ? null : permissionModeFromConfig(raw);
    }
  }

  return {
    explicit,
    modes,
    sticky,
    stickyAt,
    daemonDefault,
    draftPick,
    resolvedDefault,
    forSession,
    forDraft,
    forDraftPrompt,
    forActive,
    pickInSession,
    pickInDraft,
    setPermission,
    enterDraft,
    draftGeneration,
    materializeDraft,
    explicitSeqFor,
    settleExplicit,
    foldDaemonMode,
    clearSession,
    pruneSessions,
    sessionTeardownGenFor,
    noteSubmitPrepStart,
    noteSubmitPrepEnd,
    setDaemonDefault,
    $reset,
  };
});

export function permissionsStore() {
  return usePermissionsStore(clientPinia);
}
