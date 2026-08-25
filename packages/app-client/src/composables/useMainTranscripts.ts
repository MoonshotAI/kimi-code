// packages/app-client/src/composables/useMainTranscripts.ts
// Per-session pool of MAIN-agent TranscriptChannels for the transcript-driven
// main conversation flow (docs/plans/2026-08-19-main-transcript-protocol.md,
// S14). Unlike the detail-panel pool (one agent while the panel is open), the
// main pool keeps the most recent sessions' subscriptions ALIVE in the
// background — the LRU equivalent of the legacy subscription retention — so a
// session the user switched away from still receives live edges (background
// approval/question notifications, status updates).

import { ref, shallowReactive, type Ref } from 'vue';
import { isDaemonApiError } from '@moonshot-ai/app-core/api';
import { logWarn } from '@moonshot-ai/app-core/lib';
import {
  TranscriptChannel,
  type AgentTranscriptSnapshot,
  type TranscriptOperation,
} from '@moonshot-ai/app-core/transcript';
import type { KimiEventConnection, KimiWebApi } from '@moonshot-ai/app-core/api';

const MAIN_AGENT_ID = 'main';
const DEFAULT_MAX_RESIDENT_SESSIONS = 4;

export interface MainTranscriptEntry {
  readonly channel: TranscriptChannel;
  readonly version: Ref<number>;
  baselineLoaded: boolean;
  resumePromise: Promise<void> | null;
  /** A gap surfaced while a refresh was already in flight — re-run once the
   *  current task clears (the re-entrant call would otherwise return the
   *  in-flight promise and forget the gap). */
  gapRetryPending: boolean;
  /** A non-empty reset that arrived WHILE a refresh was in flight. The
   *  in-flight REST read commits its (older) page first; the reset must land
   *  AFTER it or the stale page would overwrite the server's newer
   *  re-anchor — leaving the client stuck on a pre-reset snapshot when the
   *  reset carried the final turn-end and no further ops ever come. */
  pendingReset: { snapshot: AgentTranscriptSnapshot; seq?: number } | null;
  /** Items-empty resets already triggered this many REST retries — the reset
   *  is NEVER accepted as the baseline (it can't carry history); the backoff
   *  interval just caps at 15s. */
  emptyResetRetries: number;
  /** Set when a successful read RECOVERED from empty-reset retries: the edge
   *  watcher's recovery branch consumes this fact (firing the pending
   *  interactions and background error notices that arrived while the
   *  baseline was unreadable) BEFORE the counter itself resets — clearing
   *  the counter in the success path would make that branch unreachable. */
  recoveredViaEmptyReset: boolean;
  /** LRU clock — bumped on activate; the oldest entries get evicted first. A
   *  strictly increasing sequence, not a wall clock: two activations in the
   *  same millisecond must still order deterministically. */
  lastTouchedSeq: number;
}

export function createMainTranscriptPool(deps: {
  api: KimiWebApi;
  /** Create the shadow event connection if it doesn't exist yet (the socket
   *  registers subscriptions while connecting and sends them on hello). */
  connectEventsIfNeeded: () => void;
  /** The transcript-only (shadow) event connection — never the legacy
   *  session_event one: the server suppresses projected events per
   *  connection×agent grade, so sharing the legacy connection would starve
   *  the old pipeline during the shadow phase. */
  getEventConnection: () => KimiEventConnection | null;
  maxResidentSessions?: number;
  /** A session's transcript read returned not-found — the session is gone
   *  server-side and needs the facade's full teardown (forgetSession). */
  onSessionGone?: (sessionId: string) => void;
  /** The facade's local-turn-start snapshot (generation/pending) — a baseline
   *  read that spans a local submit must re-anchor, not reap the prompt as
   *  leftover state. */
  getLocalTurnState?: (sessionId: string) => { generation: number; pending: boolean };
  /** True while the session has a local prompt lifecycle outstanding
   *  (in-flight/queued/optimistic work) — such entries are pinned past the
   *  resident cap so their queue can't be stranded. */
  hasPendingLocalWork?: (sessionId: string) => boolean;
  /** The session's FIRST transcript read failed (non-404): the entry is
   *  dropped so baseline waiters resolve (loading ends) instead of hanging —
   *  the facade surfaces this as an ordinary operation failure, and the next
   *  activate rebuilds the entry with a fresh read. */
  onBaselineError?: (sessionId: string, err: unknown) => void;
}) {
  const entries = shallowReactive(new Map<string, MainTranscriptEntry>());
  // Reactive so watchers iterating the pool wake when a session's first
  // subscription lands (the cold-baseline case: the entry is created after
  // the watcher first evaluated an empty pool).
  const subscribedSessions = shallowReactive(new Set<string>());
  const maxResident = deps.maxResidentSessions ?? DEFAULT_MAX_RESIDENT_SESSIONS;
  let visitSeq = 0;

  // First-read retry state per session — kept OUTSIDE the entry because the
  // entry is dropped on every failed first read: a counter on the entry would
  // restart at 1 on every rebuild, pinning the backoff at its first interval
  // forever. Cleared only by a SUCCESSFUL baseline, an explicit activate
  // (fresh user intent), a deactivate, or forgetSession.
  const firstReadRetryBySid = new Map<
    string,
    { attempt: number; timer: ReturnType<typeof setTimeout> | null }
  >();

  function cancelFirstReadRetry(sessionId: string): void {
    const state = firstReadRetryBySid.get(sessionId);
    if (state?.timer != null) clearTimeout(state.timer);
    firstReadRetryBySid.delete(sessionId);
  }

  // Sessions the user switched AWAY from since their last activate. A first
  // read still in flight at that moment must not START a retry loop when it
  // later fails: deactivate() ran before any retry state existed, so nothing
  // would ever cancel it — every quick drive-by would leave an independent
  // request loop hammering a failing read forever.
  const deactivatedSinceActivate = new Set<string>();

  // Streaming ops can notify many times per second; the version ref only feeds
  // UI recomputation, so bump it once per frame (task fallback for hidden
  // tabs) instead of once per applied batch.
  const dirtyEntries = new Set<MainTranscriptEntry>();
  let frameHandle: number | null = null;
  let taskHandle: ReturnType<typeof setTimeout> | null = null;

  function flushNotifications(): void {
    if (frameHandle !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
    if (taskHandle !== null) {
      clearTimeout(taskHandle);
      taskHandle = null;
    }
    for (const entry of dirtyEntries) entry.version.value += 1;
    dirtyEntries.clear();
  }

  function scheduleNotification(entry: MainTranscriptEntry): void {
    dirtyEntries.add(entry);
    if (frameHandle !== null || taskHandle !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      frameHandle = requestAnimationFrame(flushNotifications);
    }
    taskHandle = setTimeout(flushNotifications, 50);
  }

  function subscribeCurrent(sessionId: string, sinceSeq?: number): void {
    const connection = deps.getEventConnection();
    if (connection === null) return;
    connection.subscribeTranscript(sessionId, MAIN_AGENT_ID, sinceSeq);
    subscribedSessions.add(sessionId);
  }

  function getOrCreate(sessionId: string): MainTranscriptEntry {
    const existing = entries.get(sessionId);
    if (existing !== undefined) return existing;
    const entry: MainTranscriptEntry = {
      channel: new TranscriptChannel({
        sessionId,
        agentId: MAIN_AGENT_ID,
        fetchPage: (query) =>
          deps.api.getSessionTranscript(sessionId, { ...query, agentId: MAIN_AGENT_ID }),
        onChange: () => {
          scheduleNotification(entry);
        },
        onGap: () => {
          // A gap detected while a refresh is already running (e.g. replaying
          // buffered ops in its finally) can't re-enter — resumePromise is
          // still set and the call would return THAT promise, forgetting the
          // gap. Mark it and let the current task re-run when it clears.
          if (entry.resumePromise !== null) {
            entry.gapRetryPending = true;
            return;
          }
          void refreshAndResume(entry);
        },
      }),
      version: ref(0),
      baselineLoaded: false,
      resumePromise: null,
      gapRetryPending: false,
      pendingReset: null,
      emptyResetRetries: 0,
      recoveredViaEmptyReset: false,
      lastTouchedSeq: 0,
    };
    entries.set(sessionId, entry);
    return entry;
  }

  async function refreshAndResume(entry: MainTranscriptEntry): Promise<void> {
    if (entry.resumePromise !== null) return entry.resumePromise;
    const task = refreshAndResumeOnce(entry).finally(() => {
      if (entry.resumePromise === task) {
        entry.resumePromise = null;
        // A reset buffered while this read was in flight lands AFTER the
        // (older) REST page commits — never underneath it (see the field's
        // comment). Skipped when the entry died mid-read: its replacement
        // owns the session now.
        const pending = entry.pendingReset;
        entry.pendingReset = null;
        if (pending !== null && entries.get(entry.channel.sessionId) === entry) {
          entry.channel.receiveReset(pending.snapshot, pending.seq);
          entry.baselineLoaded = true;
          cancelFirstReadRetry(entry.channel.sessionId);
          subscribeCurrent(entry.channel.sessionId, entry.channel.seq);
        }
        if (entry.gapRetryPending) {
          entry.gapRetryPending = false;
          void refreshAndResume(entry);
        }
      }
    });
    entry.resumePromise = task;
    return task;
  }

  async function refreshAndResumeOnce(entry: MainTranscriptEntry): Promise<void> {
    const sessionId = entry.channel.sessionId;
    try {
      // A history pagination in flight must commit BEFORE this read starts:
      // its applyPage(false) landing afterwards would overwrite the fresh
      // state with the older response's stale meta/tasks/interactions/prompts
      // (and with no later op, the UI would stay there).
      await entry.channel.settleOlder().catch(() => undefined);
      // A local prompt submitted (or settled) DURING the read can postdate the
      // snapshot the server built — re-read until the local-turn state is
      // stable across a whole request (bounded: each pass re-checks), so a
      // baseline can't re-anchor BEHIND the local turn and reap it as
      // leftover state. The SECOND read needs the same gate: its own snapshot
      // may predate the POST that settled the first window's prompt.
      for (let attempt = 0; attempt < 3; attempt++) {
        const turnStateBefore = deps.getLocalTurnState?.(sessionId);
        await entry.channel.refresh();
        const turnStateAfter = deps.getLocalTurnState?.(sessionId);
        const stable =
          turnStateBefore === undefined ||
          turnStateAfter === undefined ||
          (turnStateBefore.generation === turnStateAfter.generation &&
            turnStateBefore.pending === turnStateAfter.pending);
        if (stable) break;
      }
      // A successful REST read clears the empty-reset backoff for BOTH the
      // pre-baseline and the loaded (gap-refresh) paths — but the RECOVERY
      // fact outlives the counter: the edge watcher's recovery branch reads
      // (and then clears) recoveredViaEmptyReset to fire the interactions
      // and notices that landed while the baseline was unreadable. Only the
      // PRE-baseline recovery arms it — that branch is the flag's only
      // consumer.
      if (!entry.baselineLoaded && entry.emptyResetRetries > 0) {
        entry.recoveredViaEmptyReset = true;
      }
      entry.baselineLoaded = true;
      entry.emptyResetRetries = 0;
      // Flush the pure-REST baseline BEFORE subscribing: the replay that
      // follows the subscribe must land as a SECOND frame, or entities the
      // replay carries (a turn that just ended, a fresh approval, an error
      // notice) would be folded into the first-baseline initialization and
      // swallowed as "history" — their edges never fire.
      flushNotifications();
      // The entry may have been evicted while the REST page was in flight —
      // a dead entry's late success must not clear the CURRENT entry's armed
      // first-read retry either (that would leave no entry AND no retry: the
      // next select hangs until the user switches away and back).
      if (entries.get(sessionId) === entry) {
        cancelFirstReadRetry(sessionId);
        subscribeCurrent(sessionId, entry.channel.seq);
      }
    } catch (err) {
      // A definitive not-found means the session is gone server-side (deleted
      // while we were away) — tear it down like the legacy snapshot path's
      // not-found handling instead of subscribing to a ghost.
      if (isDaemonApiError(err) && err.code === 40401) {
        deps.onSessionGone?.(sessionId);
        return;
      }
      if (entry.baselineLoaded) {
        // A RESUME refresh (gap recovery / empty-reset retry) failing is an
        // ordinary transient error: keep the entry (and its snapshot and
        // subscription) — dropping it here would blank the session, and the
        // subscription would silently consume later ops against nothing.
        if (entries.get(sessionId) === entry) {
          subscribeCurrent(sessionId);
        }
        return;
      }
      // The entry was evicted and re-created while this old request was in
      // flight — the NEW entry owns the session now; deleting it would blank
      // the session even though its own read may succeed.
      if (entries.get(sessionId) !== entry) return;
      // A failed FIRST read must not hang the baseline waiter: drop the entry
      // (whenMainTranscriptBaseline resolves on a missing entry, so loading
      // ends) and surface the failure — subscribing to a ghost would hide
      // history behind sessionLoading forever. Then retry in the background
      // on a capped backoff (the empty-reset retry shape): the entry stays
      // EVICTED until the timer rebuilds it, and the attempt counter lives
      // outside the entry so the interval keeps growing across rebuilds
      // instead of restarting at 1 on every recreate.
      entries.delete(sessionId);
      dirtyEntries.delete(entry);
      if (deactivatedSinceActivate.has(sessionId)) {
        // The user switched away while this read was in flight — a late
        // failure must not arm the retry loop (nobody is left to cancel it).
        // The eviction above already resolved baseline waiters; a fresh
        // activate rebuilds the entry on return. Still surface the failure
        // once (the session's load did fail).
        deps.onBaselineError?.(sessionId, err);
        return;
      }
      {
        const state = firstReadRetryBySid.get(sessionId) ?? { attempt: 0, timer: null };
        state.attempt += 1;
        firstReadRetryBySid.set(sessionId, state);
        // Only the FIRST failure surfaces to the user: every automatic retry
        // would re-toast the same warning (pushOperationFailure appends, no
        // dedupe), so a sustained outage would pop an identical error every
        // ≤15s forever. Retries just log; a successful baseline (or an
        // explicit activate) clears the counter and re-arms the notice.
        if (state.attempt === 1) {
          deps.onBaselineError?.(sessionId, err);
        } else {
          logWarn('[kimi-code] transcript baseline retry failed', { sessionId, attempt: state.attempt, err });
        }
        state.timer = setTimeout(
          () => {
            state.timer = null;
            // Cancelled (deactivate/forget) or superseded (a fresh activate
            // owns the session now — its entry is the live one).
            if (firstReadRetryBySid.get(sessionId) !== state) return;
            if (entries.get(sessionId) !== undefined) return;
            void refreshAndResume(getOrCreate(sessionId));
          },
          Math.min(state.attempt * 2000, 15_000),
        );
      }
    }
  }

  /** Evict beyond the resident cap: unsubscribe and drop the oldest entries. */
  function trimResident(): void {
    if (entries.size <= maxResident) return;
    const sorted = [...entries.values()].sort((a, b) => b.lastTouchedSeq - a.lastTouchedSeq);
    // Sessions with a local prompt lifecycle outstanding (in-flight/queued/
    // optimistic work) are PINNED: evicting one strands the queue — the work
    // terminal that lands later no longer walks the full onMainTurnEnd
    // lifecycle, and the cold baseline can't pass the drain gate either.
    const evictable = sorted.filter(
      (entry) => deps.hasPendingLocalWork?.(entry.channel.sessionId) !== true,
    );
    for (const entry of evictable.slice(maxResident)) {
      const sessionId = entry.channel.sessionId;
      entries.delete(sessionId);
      dirtyEntries.delete(entry);
      if (subscribedSessions.delete(sessionId)) {
        deps.getEventConnection()?.unsubscribeTranscript(sessionId, [MAIN_AGENT_ID]);
      }
    }
  }

  function activate(sessionId: string): MainTranscriptEntry {
    deps.connectEventsIfNeeded();
    // An explicit activate is fresh user intent: cancel any background retry
    // this session still had pending (its timer's guard would no-op anyway
    // once the entry exists, but the attempt counter must restart too), and
    // clear the switched-away mark so a NEW in-flight read may arm a retry.
    cancelFirstReadRetry(sessionId);
    deactivatedSinceActivate.delete(sessionId);
    const entry = getOrCreate(sessionId);
    visitSeq += 1;
    entry.lastTouchedSeq = visitSeq;
    if (entry.baselineLoaded) {
      subscribeCurrent(sessionId, entry.channel.seq);
    } else {
      void refreshAndResume(entry);
    }
    trimResident();
    return entry;
  }

  /** The user switched away: the subscription STAYS (background retention) —
   *  only the LRU pushout detaches it. A pending first-read retry, though, is
   *  nobody's wait anymore — stop it instead of hammering a failing read for
   *  a session no one watches. */
  function deactivate(sessionId: string): void {
    cancelFirstReadRetry(sessionId);
    deactivatedSinceActivate.add(sessionId);
    trimResident();
  }

  function receiveReset(
    sessionId: string,
    snapshot: AgentTranscriptSnapshot,
    seq?: number,
  ): void {
    const entry = entries.get(sessionId);
    if (entry === undefined) return;
    // An items-empty reset carries no history by contract — over an
    // already-loaded baseline it must re-anchor over REST, not wipe the
    // rebuilt window. Before any baseline it is the server's cursorless
    // answer after a FAILED REST refresh: retry the REST with a bounded
    // backoff FOREVER (interval capped) instead of ever accepting it as the
    // baseline — a reset that can't carry history must never prove a
    // non-empty session empty. A genuinely empty session's REST refresh
    // succeeds and marks the baseline through the normal path.
    if (snapshot.items.length === 0) {
      entry.emptyResetRetries += 1;
      const attempt = entry.emptyResetRetries;
      // Before any baseline it is the server's cursorless answer after a
      // FAILED REST refresh: retry the REST with a bounded backoff FOREVER
      // (interval capped) instead of ever accepting it as the baseline — a
      // reset that can't carry history must never prove a non-empty session
      // empty. Over an ALREADY-LOADED baseline it follows a failed
      // gap-refresh's cursorless resubscribe — and without the same backoff,
      // a down REST would spin a tight REST/WS loop (failed refresh →
      // cursorless subscribe → empty reset → immediate refresh…) for every
      // background resident session.
      setTimeout(
        () => {
          // Both cases converge over the same serialized read: it builds the
          // missing baseline, or re-anchors the loaded one over REST.
          if (entries.get(sessionId) === entry) {
            void refreshAndResume(entry);
          }
        },
        Math.min(attempt * 2000, 15_000),
      );
      return;
    }
    // A refresh is already in flight: buffer the reset so it lands AFTER the
    // older REST page commits (see pendingReset) — applying it now would let
    // the stale page overwrite the server's newer re-anchor a moment later.
    if (entry.resumePromise !== null) {
      entry.pendingReset = { snapshot, seq };
      return;
    }
    // Same during a HISTORY pagination: the older page's applyPage(false)
    // would overwrite the reset's newer meta/tasks/interactions/prompts
    // while the socket cursor already advanced to the reset's seq. Buffer it
    // and land it once the pagination settles.
    if (entry.channel.loadingOlder) {
      entry.pendingReset = { snapshot, seq };
      void entry.channel
        .settleOlder()
        .catch(() => undefined)
        .then(() => {
          // A pool refresh starting meanwhile owns the landing itself.
          if (entry.resumePromise !== null) return;
          const pending = entry.pendingReset;
          entry.pendingReset = null;
          if (pending !== null && entries.get(sessionId) === entry) {
            entry.channel.receiveReset(pending.snapshot, pending.seq);
            entry.baselineLoaded = true;
            cancelFirstReadRetry(sessionId);
            subscribeCurrent(sessionId, entry.channel.seq);
          }
        });
      return;
    }
    entry.channel.receiveReset(snapshot, seq);
    entry.baselineLoaded = true;
    cancelFirstReadRetry(sessionId);
  }

  function applyOps(sessionId: string, ops: readonly TranscriptOperation[], seq?: number): boolean {
    const entry = entries.get(sessionId);
    if (entry === undefined) return true;
    return entry.channel.applyOps(ops, seq);
  }

  function forgetSession(sessionId: string): void {
    cancelFirstReadRetry(sessionId);
    deactivatedSinceActivate.delete(sessionId);
    const entry = entries.get(sessionId);
    if (entry !== undefined) {
      entries.delete(sessionId);
      dirtyEntries.delete(entry);
    }
    if (subscribedSessions.delete(sessionId)) {
      deps.getEventConnection()?.unsubscribeTranscript(sessionId, [MAIN_AGENT_ID]);
    }
  }

  return {
    getEntry: (sessionId: string) => entries.get(sessionId),
    activate,
    deactivate,
    receiveReset,
    applyOps,
    forgetSession,
    /** Serialize an out-of-band refresh (undo's rewind) through the pool's
     *  resume path: a reset landing mid-read is buffered and lands AFTER the
     *  older page — a direct channel.refresh() bypasses resumePromise and
     *  lets the stale page overwrite the server's newer reset. */
    refreshSession: (sessionId: string): Promise<void> => {
      const entry = entries.get(sessionId);
      return entry === undefined ? Promise.resolve() : refreshAndResume(entry);
    },
    /** Re-run the resident-cap trim — called by the facade when a session's
     *  local-work pin clears (pinned entries don't re-trim by themselves). */
    trimResident,
    /** Test/inspection handle: which sessions currently hold a subscription. */
    subscribedSessions: subscribedSessions as ReadonlySet<string>,
  };
}
