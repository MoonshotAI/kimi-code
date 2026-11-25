
import { computed, watch, type ComputedRef, type Ref } from 'vue';

import { i18n } from '../i18n';
import type { SessionCreatedSource } from '../../shared/track-events';

export interface TrayAttentionItem {
  sessionId: string;
  title: string;
  unread: boolean;
  approvals: number;
  questions: number;
}

export interface TrayAttentionCounts {
  unread: number;
  approvals: number;
  questions: number;
  items: TrayAttentionItem[];
}

interface TrayAttentionSession {
  id: string;
  title: string;
  pendingInteraction?: 'none' | 'approval' | 'question';
}

export function buildTrayAttention(
  sessions: ReadonlyArray<TrayAttentionSession>,
  visibleSessionIds: ReadonlySet<string>,
  unreadBySession: Record<string, boolean>,
  pendingBySession: Record<string, { approvals: number; questions: number }>,
): TrayAttentionCounts {
  const items: TrayAttentionItem[] = [];
  let unread = 0;
  let approvals = 0;
  let questions = 0;
  for (const session of sessions) {
    if (!visibleSessionIds.has(session.id)) continue;
    const flag = unreadBySession[session.id] === true;
    const pending = pendingBySession[session.id];
    let itemApprovals = pending?.approvals ?? 0;
    let itemQuestions = pending?.questions ?? 0;
    if (pending === undefined) {
      if (session.pendingInteraction === 'approval') itemApprovals = 1;
      else if (session.pendingInteraction === 'question') itemQuestions = 1;
    }
    if (!flag && itemApprovals === 0 && itemQuestions === 0) continue;
    if (flag) unread += 1;
    approvals += itemApprovals;
    questions += itemQuestions;
    items.push({
      sessionId: session.id,
      title: session.title,
      unread: flag,
      approvals: itemApprovals,
      questions: itemQuestions,
    });
  }
  return { unread, approvals, questions, items };
}

export function trayAttentionEqual(a: TrayAttentionCounts, b: TrayAttentionCounts): boolean {
  if (
    a.unread !== b.unread ||
    a.approvals !== b.approvals ||
    a.questions !== b.questions ||
    a.items.length !== b.items.length
  ) {
    return false;
  }
  return a.items.every((item, index) => {
    const other = b.items[index]!;
    return (
      item.sessionId === other.sessionId &&
      item.title === other.title &&
      item.unread === other.unread &&
      item.approvals === other.approvals &&
      item.questions === other.questions
    );
  });
}

export function createTrayAttentionReporter(
  bridge: Pick<TrayAttentionBridge, 'setTrayAttention'> | undefined,
  attention: ComputedRef<TrayAttentionCounts | null>,
): () => void {
  if (bridge === undefined) {
    return () => {};
  }
  let lastPushed: TrayAttentionCounts | null = null;
  return watch(
    attention,
    (value) => {
      if (value === null) return;
      if (lastPushed !== null && trayAttentionEqual(value, lastPushed)) {
        return;
      }
      lastPushed = value;
      bridge.setTrayAttention(value);
    },
    { immediate: true },
  );
}

export function createTraySessionSelector(
  bridge: Pick<TrayAttentionBridge, 'onTraySelectSession'> | undefined,
  openSession: (sessionId: string) => void,
): () => void {
  if (bridge === undefined) {
    return () => {};
  }
  return bridge.onTraySelectSession(openSession);
}

export function runWhenInitialized(initialized: Ref<boolean>, fn: () => void): () => void {
  if (initialized.value) {
    fn();
    return () => {};
  }
  const stop = watch(initialized, (ready) => {
    if (!ready) return;
    stop();
    fn();
  });
  return stop;
}

interface TrayAttentionBridge {
  setTrayAttention: (attention: TrayAttentionCounts) => void;
  onTraySelectSession: (cb: (sessionId: string) => void) => () => void;
  setLocale: (locale: 'en' | 'zh') => void;
}

export function createTrayLocaleSync(
  bridge: Pick<TrayAttentionBridge, 'setLocale'> | undefined,
  locale: Ref<string>,
): () => void {
  if (bridge === undefined) {
    return () => {};
  }
  return watch(
    locale,
    (value) => {
      bridge.setLocale(value === 'zh' ? 'zh' : 'en');
    },
    { immediate: true },
  );
}

interface TrayAttentionSource {
  sessions: ComputedRef<ReadonlyArray<TrayAttentionSession>>;
  sessionsForView: ComputedRef<ReadonlyArray<{ id: string }>>;
  unreadBySession: ComputedRef<Record<string, boolean>>;
  pendingBySession: ComputedRef<Record<string, { approvals: number; questions: number }>>;
  initialized: Ref<boolean>;
  selectSession: (
    sessionId: string,
    opts?: { source?: SessionCreatedSource },
  ) => Promise<void>;
}

export function useTrayAttention(client: TrayAttentionSource): void {
  const bridge = (window as { kimiDesktop?: TrayAttentionBridge }).kimiDesktop;
  if (
    typeof bridge?.setTrayAttention !== 'function' ||
    typeof bridge.onTraySelectSession !== 'function' ||
    typeof bridge.setLocale !== 'function'
  ) {
    return;
  }
  const visibleSessionIds = computed(
    () => new Set(client.sessionsForView.value.map((session) => session.id)),
  );
  const attention = computed<TrayAttentionCounts | null>(() => {
    if (!client.initialized.value) return null;
    return buildTrayAttention(
      client.sessions.value,
      visibleSessionIds.value,
      client.unreadBySession.value,
      client.pendingBySession.value,
    );
  });
  createTrayAttentionReporter(bridge, attention);
  createTraySessionSelector(bridge, (sessionId) => {
    runWhenInitialized(client.initialized, () => {
      void client.selectSession(sessionId, { source: 'tray' }).catch(() => {});
    });
  });
  createTrayLocaleSync(bridge, i18n.global.locale);
}
