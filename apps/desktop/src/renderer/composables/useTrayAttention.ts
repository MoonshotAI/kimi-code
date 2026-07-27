// Desktop-only: pushes the global pending-attention state — unread sessions
// (a background turn finished, not yet opened) + awaiting approvals + awaiting
// questions — to the native tray, and routes tray menu clicks back into the
// app. The main process renders the bare total next to the macOS menu-bar icon
// (Tray.setTitle is macOS-only), the per-kind breakdown in the tray tooltip,
// and the attention sessions as clickable menu entries (click → window shows
// and jumps to that session; see src/main/tray.ts).
//
// Why a push reporter: the unread flags and pending approvals/questions are
// projected in renderer state (localStorage-backed + WS events), so the main
// process only knows what it is told. The reload recovery and the keep-last-
// known-across-reload behaviour live on the main side (window.ts / the
// immediate push); the reverse direction (tray click → selectSession) queues
// in window.ts while the renderer is (re)loading — with hide-on-close
// it otherwise delivers immediately.
//
// With no bridge — plain web, tests — the reporter never starts, so this file
// is a safe no-op in apps/web (no-bridge fallback, per native-todos.md).

import { computed, watch, type ComputedRef, type Ref } from 'vue';

import { i18n } from '../i18n';

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
  /** List-level pending fact from the sessions endpoint (same one the
      SessionRow badges fall back to): set for sessions whose detailed
      approvals/questions have not been loaded in this client. */
  pendingInteraction?: 'none' | 'approval' | 'question';
}

/** Pure projection over the sidebar-visible session list: every visible
    session that is unread OR has pending approvals/questions becomes an item
    (keeping the session list's recency order), and ALL totals are derived
    from those items.
 *
 *  Why the visible-set filter: `sessionsForView` excludes side-chat child
 *  sessions and sessions of removed workspaces (it is what the sidebar
 *  renders), so the tray can't resurface sessions the user deliberately hid —
 *  and unread flags left behind by archived/forgotten sessions (forgetSession
 *  does not clean the unread map) can't inflate the count without an item.
 *
 *  Why the pendingInteraction fallback: sessions never opened in this client
 *  have no pendingBySession entry, so their awaiting approval/question would
 *  otherwise miss the tray until opened — exactly the background sessions the
 *  badge exists for. Details win once loaded (the fallback is 1 per kind). */
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

/** Structural equality between two attention payloads. The reporter's
    computed re-evaluates on every `sessionTimeClock` tick (the sessions list
    re-sorts for relative-time display), producing fresh but identical
    objects — without this check every tick would re-push and rebuild the
    native menu for nothing. */
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

/** Watch the attention state and push every change to the native tray.
    A null value means "client state not loaded yet" and is NOT pushed: at
    App.vue setup the session list is still empty (client.load() only starts
    in onMounted), so an immediate zeros push would wipe the main process's
    last-known tray state — kept across window close / reload — for the whole
    load window. The first real push therefore carries the loaded state.
    Identical successive payloads are pushed only once. Returns the stop
    handle; a missing bridge yields a no-op reporter. */
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

/** Subscribe to tray attention-entry clicks (main → renderer) and route them
    to the session opener. Returns the unsubscribe; no-op without the bridge. */
export function createTraySessionSelector(
  bridge: Pick<TrayAttentionBridge, 'onTraySelectSession'> | undefined,
  openSession: (sessionId: string) => void,
): () => void {
  if (bridge === undefined) {
    return () => {};
  }
  return bridge.onTraySelectSession(openSession);
}

/** Run fn once the client's initial load() has settled — immediately when it
    already has, otherwise on the flip. Tray session clicks arriving during
    the initial load must wait: selectSession before the session list is
    populated sets an active session it cannot attach to a workspace, and the
    initial load then skips its own deep-link/auto-select (both are guarded by
    "no active session"). */
export function runWhenInitialized(initialized: Ref<boolean>, fn: () => void): void {
  if (initialized.value) {
    fn();
    return;
  }
  const stop = watch(initialized, (ready) => {
    if (!ready) return;
    stop();
    fn();
  });
}

// Subset of the preload `kimiDesktop` bridge this reporter needs.
interface TrayAttentionBridge {
  setTrayAttention: (attention: TrayAttentionCounts) => void;
  onTraySelectSession: (cb: (sessionId: string) => void) => () => void;
  setLocale: (locale: 'en' | 'zh') => void;
}

/** Push the in-app language to the main process so native surfaces (the tray
    menu/tooltip) follow it. Immediate push covers boot; the watch covers
    language switches. Returns the stop handle; no-op without the bridge. */
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
  /** Global session list (recency order, carries pendingInteraction). */
  sessions: ComputedRef<ReadonlyArray<TrayAttentionSession>>;
  /** The sidebar's visibility projection — defines which sessions may appear. */
  sessionsForView: ComputedRef<ReadonlyArray<{ id: string }>>;
  unreadBySession: ComputedRef<Record<string, boolean>>;
  pendingBySession: ComputedRef<Record<string, { approvals: number; questions: number }>>;
  /** False until the client's first load() settles (see useWorkspaceState). */
  initialized: Ref<boolean>;
  selectSession: (sessionId: string) => Promise<void>;
}

/** App.vue wiring: report the client's global attention state to the tray and
    open sessions for tray menu clicks. Lives for the app's lifetime, so the
    watchers'/subscription's stop handles are never needed. */
export function useTrayAttention(client: TrayAttentionSource): void {
  const bridge = (window as { kimiDesktop?: TrayAttentionBridge }).kimiDesktop;
  // A missing bridge method (old build) degrades to the same no-op as no bridge.
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
    // Gate the first push on the client's initial load: before it settles the
    // session list is empty, so the push would be zeros that wipe the main
    // process's last-known tray state for the whole load window.
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
      // Fire-and-forget: a failed/stale jump must never break the tray path.
      void client.selectSession(sessionId).catch(() => {});
    });
  });
  createTrayLocaleSync(bridge, i18n.global.locale);
}
