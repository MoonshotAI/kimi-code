import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppSession } from '@moonshot-ai/app-core/api';
import {
  basename,
  STORAGE_KEYS,
  loadUnread,
  parsePinnedEntryKey,
  partitionByPinned,
  reconcilePinnedOrder,
  saveUnread,
  sessionDisplayStatus,
} from '@moonshot-ai/app-core/lib';
import type { PinnedEntry, Session, WorkspaceGroup } from '@moonshot-ai/app-core/client/types';
import { createSessionRowMemo, createWorkspaceGroupMemo } from '@moonshot-ai/app-core/client';
import { t } from '../client/deps';
import { clientPinia } from './pinia';
import { approvalsStore } from './approvals';
import { devicesStore } from './devices';
import { pinnedOrderStore } from './pinnedOrder';
import { promptStore } from './prompt';
import { sessionsStore } from './sessions';
import { SESSIONS_INITIAL_PAGE_SIZE, workspacesStore } from './workspaces';

export function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffH = diffMs / 3600000;
    if (diffMs < 60000) return t('sessions.justNow');
    if (diffH < 1) return `${Math.round(diffMs / 60000)}m`;
    if (diffH < 24) return `${Math.round(diffH)}h`;
    const diffD = diffMs / 86400000;
    if (diffD < 7) return `${Math.round(diffD)}d`;
    if (diffD < 30) return `${Math.round(diffD / 7)}w`;
    if (diffD < 365) return `${Math.round(diffD / 30)}mo`;
    return `${Math.round(diffD / 365)}y`;
  } catch {
    return iso;
  }
}

const SESSION_TIME_CLOCK_INTERVAL_MS = 30_000;
let sessionTimeClockTimer: ReturnType<typeof setInterval> | null = null;
let sessionTimeClockResumeTimer: ReturnType<typeof setTimeout> | null = null;
let sessionTimeClockVisibilityListener: (() => void) | null = null;
let sessionTimeClockLastTickAt = 0;

function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export const useSessionViewsStore = defineStore('kimi.sessionViews', () => {
  const unreadState = ref<Record<string, boolean>>(loadUnread());
  const manualUnreadState = ref<Record<string, boolean>>(loadUnread(STORAGE_KEYS.manualUnread));
  const flatSessionsFrontier = ref<number | null>(null);
  const sessionTimeClock = ref(0);
  const localApprovalCounts = ref<Record<string, number>>({});

  function tickSessionTimeClock(): void {
    sessionTimeClockLastTickAt = Date.now();
    sessionTimeClock.value = (sessionTimeClock.value + 1) % Number.MAX_SAFE_INTEGER;
  }

  function startSessionTimeClockTimer(): void {
    if (sessionTimeClockTimer !== null) return;
    sessionTimeClockTimer = setInterval(tickSessionTimeClock, SESSION_TIME_CLOCK_INTERVAL_MS);
    (sessionTimeClockTimer as { unref?: () => void }).unref?.();
  }

  function clearSessionTimeClockTimer(): void {
    if (sessionTimeClockResumeTimer !== null) {
      clearTimeout(sessionTimeClockResumeTimer);
      sessionTimeClockResumeTimer = null;
    }
    if (sessionTimeClockTimer === null) return;
    clearInterval(sessionTimeClockTimer);
    sessionTimeClockTimer = null;
  }

  function resumeSessionTimeClock(): void {
    if (sessionTimeClockTimer !== null || sessionTimeClockResumeTimer !== null) return;
    const remaining = SESSION_TIME_CLOCK_INTERVAL_MS - (Date.now() - sessionTimeClockLastTickAt);
    if (remaining <= 0) {
      tickSessionTimeClock();
      startSessionTimeClockTimer();
      return;
    }
    sessionTimeClockResumeTimer = setTimeout(() => {
      sessionTimeClockResumeTimer = null;
      tickSessionTimeClock();
      startSessionTimeClockTimer();
    }, remaining);
    (sessionTimeClockResumeTimer as { unref?: () => void }).unref?.();
  }

  function onSessionTimeClockVisibilityChange(): void {
    if (documentHidden()) {
      clearSessionTimeClockTimer();
      return;
    }
    resumeSessionTimeClock();
  }

  function ensureSessionTimeClock(): void {
    if (sessionTimeClockTimer !== null || sessionTimeClockVisibilityListener !== null) return;
    sessionTimeClockLastTickAt = Date.now();
    if (typeof document !== 'undefined') {
      sessionTimeClockVisibilityListener = onSessionTimeClockVisibilityChange;
      document.addEventListener('visibilitychange', sessionTimeClockVisibilityListener);
    }
    if (!documentHidden()) startSessionTimeClockTimer();
  }

  function stopSessionTimeClock(): void {
    clearSessionTimeClockTimer();
    if (sessionTimeClockVisibilityListener === null) return;
    document.removeEventListener('visibilitychange', sessionTimeClockVisibilityListener);
    sessionTimeClockVisibilityListener = null;
  }

  function markUnread(sessionId: string): void {
    unreadState.value[sessionId] = true;
    saveUnread({ [sessionId]: true });
  }

  function markManualUnread(sessionId: string): void {
    manualUnreadState.value[sessionId] = true;
    saveUnread({ [sessionId]: true }, STORAGE_KEYS.manualUnread);
  }

  function clearAutomaticUnread(sessionId: string): void {
    unreadState.value[sessionId] = false;
    saveUnread({ [sessionId]: false });
  }

  function clearUnread(sessionId: string): void {
    clearAutomaticUnread(sessionId);
    manualUnreadState.value[sessionId] = false;
    saveUnread({ [sessionId]: false }, STORAGE_KEYS.manualUnread);
  }

  function reloadUnread(): void {
    unreadState.value = loadUnread();
    manualUnreadState.value = loadUnread(STORAGE_KEYS.manualUnread);
  }

  const unreadBySession = computed<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {};
    for (const [sid, unread] of Object.entries(unreadState.value)) {
      if (unread) out[sid] = true;
    }
    for (const [sid, unread] of Object.entries(manualUnreadState.value)) {
      if (unread) out[sid] = true;
    }
    return out;
  });

  function setFlatSessionsFrontier(value: number | null): void {
    flatSessionsFrontier.value = value;
  }

  const sessionById = computed<ReadonlyMap<string, AppSession>>(
    () => new Map(sessionsStore().sessions.map((session) => [session.id, session])),
  );

  function isMainTurnActive(sessionId: string, listed?: boolean): boolean {
    return (
      (promptStore().inFlightBySession[sessionId] ?? false) ||
      (listed ?? sessionById.value.get(sessionId)?.mainTurnActive ?? false)
    );
  }

  const forViewRows = createSessionRowMemo();
  const flatRows = createSessionRowMemo();
  const pinnedRows = createSessionRowMemo();
  const desktopGroups = createWorkspaceGroupMemo();
  const desktopPinnedGroups = createWorkspaceGroupMemo();
  const mobileGroups = createWorkspaceGroupMemo();

  const attentionBySession = computed<Record<string, number>>(() => {
    const out: Record<string, number> = { ...localApprovalCounts.value };
    for (const [sid, list] of Object.entries(approvalsStore().approvalsBySession)) {
      if (list.length > 0) out[sid] = (out[sid] ?? 0) + list.length;
    }
    for (const [sid, list] of Object.entries(approvalsStore().questionsBySession)) {
      if (list.length > 0) out[sid] = (out[sid] ?? 0) + list.length;
    }
    return out;
  });

  const pendingBySession = computed<Record<string, { approvals: number; questions: number }>>(() => {
    const out: Record<string, { approvals: number; questions: number }> = Object.fromEntries(Object.entries(localApprovalCounts.value).map(([sid, count]) => [sid, { approvals: count, questions: 0 }]));
    for (const [sid, list] of Object.entries(approvalsStore().approvalsBySession)) {
      if (list.length > 0) (out[sid] ??= { approvals: 0, questions: 0 }).approvals += list.length;
    }
    for (const [sid, list] of Object.entries(approvalsStore().questionsBySession)) {
      if (list.length > 0) (out[sid] ??= { approvals: 0, questions: 0 }).questions = list.length;
    }
    return out;
  });

  const attentionByWorkspace = computed<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    const perSession = attentionBySession.value;
    const { visibleWorkspaceIds, workspaceIdForSession } = workspacesStore();
    for (const s of sessionsStore().sessions) {
      const count = perSession[s.id] ?? 0;
      if (count <= 0) continue;
      const wid = workspaceIdForSession(s);
      if (!visibleWorkspaceIds.has(wid)) continue;
      out[wid] = (out[wid] ?? 0) + count;
    }
    return out;
  });

  const sessionsForView = computed<Session[]>(() => {
    void sessionTimeClock.value;
    const { visibleWorkspaceIds, workspaceById, workspaceIdForSession } = workspacesStore();
    return forViewRows(
      sessionsStore().sessions
        .filter((s) => !s.parentSessionId && visibleWorkspaceIds.has(workspaceIdForSession(s)))
        .map((s) => {
          const workspaceId = workspaceIdForSession(s);
          const ws = workspaceById.get(workspaceId);
          return {
            id: s.id,
            title: s.title,
            time: formatTime(s.updatedAt),
            busy: isMainTurnActive(s.id, s.mainTurnActive),
            pendingInteraction: s.pendingInteraction,
            lastTurnReason: s.lastTurnReason,
            lastPrompt: s.lastPrompt,
            workspaceId,
            workspaceName: ws?.name,
            deviceId: ws?.deviceId,
          };
        }),
    );
  });

  const flatSessionsAll = computed<Session[]>(() => {
    void sessionTimeClock.value;
    const { visibleWorkspaceIds, workspaceById, workspaceIdForSession } = workspacesStore();
    const pinnedSet = new Set(sessionsStore().pinnedSessionIds);
    const byUpdatedDesc = (a: AppSession, b: AppSession) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    const frontier = flatSessionsFrontier.value;
    const rows: AppSession[] = [];
    for (const s of sessionsStore().sessions) {
      if (
        s.parentSessionId ||
        s.archived ||
        pinnedSet.has(s.id) ||
        !visibleWorkspaceIds.has(workspaceIdForSession(s))
      ) {
        continue;
      }
      const hasStatus =
        sessionDisplayStatus({
          busy: isMainTurnActive(s.id, s.mainTurnActive),
          unread: unreadBySession.value[s.id] ?? false,
          questionCount: pendingBySession.value[s.id]?.questions ?? 0,
          approvalCount: pendingBySession.value[s.id]?.approvals ?? 0,
          pendingInteraction: s.pendingInteraction,
          lastTurnReason: s.lastTurnReason,
        }) !== 'idle';
      if (!hasStatus && frontier !== null && new Date(s.updatedAt).getTime() < frontier) continue;
      rows.push(s);
    }
    rows.sort(byUpdatedDesc);
    return flatRows(
      rows.map((s) => {
        const workspaceId = workspaceIdForSession(s);
        const ws = workspaceById.get(workspaceId);
        return {
          id: s.id,
          title: s.title,
          time: formatTime(s.updatedAt),
          busy: isMainTurnActive(s.id, s.mainTurnActive),
          pendingInteraction: s.pendingInteraction,
          lastTurnReason: s.lastTurnReason,
          lastPrompt: s.lastPrompt,
          updatedAt: s.updatedAt,
          workspaceId,
          workspaceName: ws?.name,
          deviceId: ws?.deviceId,
          cwdLabel: s.cwd ? basename(s.cwd) : '-',
          pullRequest: s.pullRequest,
        };
      }),
    );
  });

  const unpinnedFlatSessionsAll = computed<Session[]>(() => {
    const pinned = new Set(workspacesStore().pinnedWorkspaceIds);
    if (pinned.size === 0) return flatSessionsAll.value;
    return flatSessionsAll.value.filter((s) => !pinned.has(s.workspaceId ?? ''));
  });

  function buildWorkspaceGroups(excludePinned: boolean): WorkspaceGroup[] {
    void sessionTimeClock.value;
    const pinnedSet = new Set(sessionsStore().pinnedSessionIds);
    const byId = new Map<string, Session[]>();
    const pinnedCountByWorkspace = new Map<string, number>();
    for (const s of sessionsStore().sessions.toSorted(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )) {
      if (s.parentSessionId) continue;
      if (s.archived) continue;
      const wid = workspacesStore().workspaceIdForSession(s);
      if (excludePinned && pinnedSet.has(s.id)) {
        pinnedCountByWorkspace.set(wid, (pinnedCountByWorkspace.get(wid) ?? 0) + 1);
        continue;
      }
      const view: Session = {
        id: s.id,
        title: s.title,
        time: formatTime(s.updatedAt),
        busy: isMainTurnActive(s.id, s.mainTurnActive),
        pendingInteraction: s.pendingInteraction,
        lastTurnReason: s.lastTurnReason,
        updatedAt: s.updatedAt,
      };
      const list = byId.get(wid) ?? [];
      list.push(view);
      byId.set(wid, list);
    }
    return workspacesStore().workspacesView.map((w) => {
      const unavailable = devicesStore().unavailable(w.deviceId);
      return {
        workspace: w,
        sessions: unavailable ? [] : byId.get(w.id) ?? [],
        pinnedCount: unavailable ? 0 : pinnedCountByWorkspace.get(w.id) ?? 0,
        hasMore: !unavailable && (workspacesStore().sessionsHasMoreByWorkspace[w.id] ?? false),
        loadingMore: !unavailable && (workspacesStore().sessionsLoadingMoreByWorkspace[w.id] ?? false),
        initialCount: workspacesStore().sessionsInitialCountByWorkspace[w.id] ?? SESSIONS_INITIAL_PAGE_SIZE,
      };
    });
  }

  const workspaceGroups = computed<WorkspaceGroup[]>(() => desktopGroups(buildWorkspaceGroups(true)));

  const unpinnedWorkspaceGroups = computed<WorkspaceGroup[]>(() => {
    const pinned = new Set(workspacesStore().pinnedWorkspaceIds);
    return workspaceGroups.value.filter((group) => !pinned.has(group.workspace.id));
  });

  const pinnedWorkspaceGroups = computed<WorkspaceGroup[]>(() => {
    const byId = new Map(workspaceGroups.value.map((group) => [group.workspace.id, group]));
    const pinned = workspacesStore().pinnedWorkspaceIds
      .map((id) => byId.get(id))
      .filter((group): group is WorkspaceGroup => group !== undefined);
    return desktopPinnedGroups(pinned);
  });

  const mobileWorkspaceGroups = computed<WorkspaceGroup[]>(() => mobileGroups(buildWorkspaceGroups(false)));

  const pinnedSessions = computed<Session[]>(() => {
    void sessionTimeClock.value;
    const { visibleWorkspaceIds, workspaceById, workspaceIdForSession } = workspacesStore();
    const candidates = sessionsStore().sessions.filter(
      (s) =>
        !s.parentSessionId && !s.archived && visibleWorkspaceIds.has(workspaceIdForSession(s)),
    );
    const pinned = partitionByPinned(candidates, sessionsStore().pinnedSessionIds).pinned;
    return pinnedRows(
      pinned.map((s) => {
        const workspaceId = workspaceIdForSession(s);
        const ws = workspaceById.get(workspaceId);
        return {
          id: s.id,
          title: s.title,
          time: formatTime(s.updatedAt),
          busy: isMainTurnActive(s.id, s.mainTurnActive),
          pendingInteraction: s.pendingInteraction,
          lastTurnReason: s.lastTurnReason,
          updatedAt: s.updatedAt,
          workspaceId,
          workspaceName: ws?.name,
          deviceId: ws?.deviceId,
          pinned: true,
          cwdLabel: s.cwd ? basename(s.cwd) : '-',
          pullRequest: s.pullRequest,
        };
      }),
    );
  });

  let prevPinnedEntries: PinnedEntry[] = [];

  const pinnedEntries = computed<PinnedEntry[]>(() => {
    const groupsById = new Map(
      pinnedWorkspaceGroups.value.map((group) => [group.workspace.id, group]),
    );
    const sessionsById = new Map(
      pinnedSessions.value.map((session) => [session.id, session]),
    );
    const orderedKeys = reconcilePinnedOrder(
      pinnedOrderStore().pinnedOrder,
      workspacesStore().pinnedWorkspaceIds,
      sessionsStore().pinnedSessionIds,
    );
    const next: PinnedEntry[] = [];
    for (const key of orderedKeys) {
      const parsed = parsePinnedEntryKey(key);
      if (!parsed) continue;
      if (parsed.kind === 'workspace') {
        const group = groupsById.get(parsed.id);
        if (group) next.push({ key, kind: 'workspace', group });
      } else {
        const session = sessionsById.get(parsed.id);
        if (session) next.push({ key, kind: 'session', session });
      }
    }
    if (
      next.length === prevPinnedEntries.length &&
      next.every((entry, idx) => {
        const prev = prevPinnedEntries[idx]!;
        return (
          prev.key === entry.key &&
          prev.kind === entry.kind &&
          (entry.kind === 'workspace'
            ? prev.kind === 'workspace' && prev.group === entry.group
            : prev.kind === 'session' && prev.session === entry.session)
        );
      })
    ) {
      return prevPinnedEntries;
    }
    prevPinnedEntries = next;
    return next;
  });

  const activeSessionTitle = computed<string>(() => {
    const id = sessionsStore().activeSessionId;
    return sessionsStore().sessions.find((s) => s.id === id)?.title ?? '';
  });

  const activeSessionPinned = computed<boolean>(() => {
    const id = sessionsStore().activeSessionId;
    return !!id && sessionsStore().pinnedSessionIds.includes(id);
  });

  const activeLastTurnReason = computed(() => {
    const id = sessionsStore().activeSessionId;
    return sessionsStore().sessions.find((s) => s.id === id)?.lastTurnReason ?? null;
  });

  function recentSessionsForWorkspace(
    workspaceId: string | null,
    limit: number,
    doneSessions: AppSession[],
  ): Session[] {
    if (!workspaceId) return [];
    const ws = workspacesStore().workspaceById.get(workspaceId);
    if (devicesStore().unavailable(ws?.deviceId)) return [];
    const toRow = (s: AppSession, doneAt?: string): Session => ({
      id: s.id,
      title: s.title,
      time: formatTime(doneAt ?? s.updatedAt),
      busy: doneAt === undefined && isMainTurnActive(s.id, s.mainTurnActive),
      pendingInteraction: doneAt === undefined ? s.pendingInteraction : undefined,
      lastTurnReason: doneAt === undefined ? s.lastTurnReason : undefined,
      lastPrompt: s.lastPrompt,
      updatedAt: doneAt ?? s.updatedAt,
      workspaceId,
      workspaceName: ws?.name,
      deviceId: ws?.deviceId,
      archived: doneAt !== undefined,
      cwdLabel: s.cwd ? basename(s.cwd) : '-',
      pullRequest: s.pullRequest,
    });
    const open = sessionsStore().sessions
      .filter(
        (s) => !s.parentSessionId && !s.archived && workspacesStore().workspaceIdForSession(s) === workspaceId,
      )
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const done = doneSessions.filter((s) => workspacesStore().workspaceIdForSession(s) === workspaceId);
    return [
      ...open.map((s) => toRow(s)),
      ...done.map((s) => toRow(s, s.updatedAt)),
    ].slice(0, limit);
  }

  return {
    unreadBySession,
    flatSessionsFrontier,
    sessionTimeClock,
    localApprovalCounts,
    sessionsForView,
    flatSessionsAll,
    unpinnedFlatSessionsAll,
    workspaceGroups,
    unpinnedWorkspaceGroups,
    pinnedWorkspaceGroups,
    mobileWorkspaceGroups,
    pinnedSessions,
    pinnedEntries,
    attentionBySession,
    pendingBySession,
    attentionByWorkspace,
    activeSessionTitle,
    activeSessionPinned,
    activeLastTurnReason,
    isMainTurnActive,
    recentSessionsForWorkspace,
    markUnread,
    markManualUnread,
    clearAutomaticUnread,
    clearUnread,
    reloadUnread,
    setFlatSessionsFrontier,
    ensureSessionTimeClock,
    stopSessionTimeClock,
  };
});

export function sessionViewsStore() {
  return useSessionViewsStore(clientPinia);
}
