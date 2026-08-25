import { ref, shallowReactive, type Ref } from 'vue';
import {
  TranscriptChannel,
  type AgentTranscriptSnapshot,
  type TranscriptOperation,
} from '@moonshot-ai/app-core/transcript';
import type { KimiEventConnection, KimiWebApi } from '@moonshot-ai/app-core/api';

export interface AuxiliaryTranscriptEntry {
  readonly channel: TranscriptChannel;
  readonly version: Ref<number>;
  baselineLoaded: boolean;
  resumePromise: Promise<void> | null;
}

export function createAuxiliaryTranscriptPool(deps: {
  api: KimiWebApi;
  connectEventsIfNeeded: () => void;
  getEventConnection: () => KimiEventConnection | null;
}) {
  const entries = shallowReactive(new Map<string, AuxiliaryTranscriptEntry>());
  // Reactive: the interaction-merge watcher in useKimiWebClient reads the
  // current detail agent per session from this map — the entry it points at
  // can change with every panel open/close, and the merge must re-run then.
  const desiredAgentBySession = shallowReactive(new Map<string, string>());
  const subscribedAgentBySession = new Map<string, string>();

  // Streaming ops can notify many times per second; the version ref only feeds
  // UI recomputation, so bump it once per frame (task fallback for hidden
  // tabs) instead of once per applied batch.
  const dirtyEntries = new Set<AuxiliaryTranscriptEntry>();
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

  function scheduleNotification(entry: AuxiliaryTranscriptEntry): void {
    dirtyEntries.add(entry);
    if (frameHandle !== null || taskHandle !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      frameHandle = requestAnimationFrame(flushNotifications);
    }
    taskHandle = setTimeout(flushNotifications, 50);
  }

  function keyOf(sessionId: string, agentId: string): string {
    return `${sessionId}\0${agentId}`;
  }

  function subscribeCurrent(sessionId: string, agentId: string, sinceSeq?: number): void {
    const connection = deps.getEventConnection();
    if (connection === null) return;
    connection.subscribeTranscript(sessionId, agentId, sinceSeq);
    subscribedAgentBySession.set(sessionId, agentId);
  }

  function getOrCreate(sessionId: string, agentId: string): AuxiliaryTranscriptEntry {
    const key = keyOf(sessionId, agentId);
    const existing = entries.get(key);
    if (existing !== undefined) return existing;
    const entry: AuxiliaryTranscriptEntry = {
      channel: new TranscriptChannel({
        sessionId,
        agentId,
        fetchPage: (query) =>
          deps.api.getSessionTranscript(sessionId, { ...query, agentId }),
        onChange: () => {
          scheduleNotification(entry);
        },
        onGap: () => {
          void refreshAndResume(entry);
        },
      }),
      version: ref(0),
      baselineLoaded: false,
      resumePromise: null,
    };
    entries.set(key, entry);
    return entry;
  }

  async function refreshAndResume(entry: AuxiliaryTranscriptEntry): Promise<void> {
    if (entry.resumePromise !== null) return entry.resumePromise;
    const task = refreshAndResumeOnce(entry).finally(() => {
      if (entry.resumePromise === task) entry.resumePromise = null;
    });
    entry.resumePromise = task;
    return task;
  }

  async function refreshAndResumeOnce(entry: AuxiliaryTranscriptEntry): Promise<void> {
    // The entry must still be the live one for its (session, agent) pair
    // before re-subscribing: deactivate() evicts entries, and a fast
    // close→reopen of the same agent replaces this entry with a fresh one
    // whose own refresh establishes the current subscription. Letting this
    // stale chain subscribe with its old channel's seq would shadow the
    // fresh channel and could drop ops between the two watermarks.
    const isCurrentEntry = (): boolean =>
      entries.get(keyOf(entry.channel.sessionId, entry.channel.agentId)) === entry;
    try {
      await entry.channel.refresh();
      entry.baselineLoaded = true;
      if (
        isCurrentEntry() &&
        desiredAgentBySession.get(entry.channel.sessionId) === entry.channel.agentId
      ) {
        subscribeCurrent(
          entry.channel.sessionId,
          entry.channel.agentId,
          entry.channel.seq,
        );
      }
    } catch {
      if (
        isCurrentEntry() &&
        desiredAgentBySession.get(entry.channel.sessionId) === entry.channel.agentId
      ) {
        subscribeCurrent(entry.channel.sessionId, entry.channel.agentId);
      }
    }
  }

  function activate(sessionId: string, agentId: string): AuxiliaryTranscriptEntry {
    deps.connectEventsIfNeeded();
    // Transcript subscriptions are additive now — switching the detail panel
    // to another agent must detach the previous one explicitly, or every
    // visited agent keeps streaming (and re-subscribing on reconnect).
    const previous = subscribedAgentBySession.get(sessionId);
    if (previous !== undefined && previous !== agentId) {
      deps.getEventConnection()?.unsubscribeTranscript(sessionId, [previous]);
      subscribedAgentBySession.delete(sessionId);
    }
    desiredAgentBySession.set(sessionId, agentId);
    const entry = getOrCreate(sessionId, agentId);
    if (entry.baselineLoaded) {
      subscribeCurrent(sessionId, agentId, entry.channel.seq);
    } else {
      void refreshAndResume(entry);
    }
    return entry;
  }

  function deactivate(sessionId: string, agentId: string): void {
    if (desiredAgentBySession.get(sessionId) !== agentId) return;
    desiredAgentBySession.delete(sessionId);
    const subscribedAgent = subscribedAgentBySession.get(sessionId);
    if (subscribedAgent !== undefined) {
      deps.getEventConnection()?.unsubscribeTranscript(sessionId, [subscribedAgent]);
      subscribedAgentBySession.delete(sessionId);
    }
    // Evict the transcript entry: with the panel closed (or moved to another
    // agent/session) nothing reads this agent's transcript, and keeping it
    // pins the full op log for the app's lifetime. Re-activation rebuilds the
    // entry from a fresh baseline fetch.
    const key = keyOf(sessionId, agentId);
    const entry = entries.get(key);
    if (entry !== undefined) {
      entries.delete(key);
      dirtyEntries.delete(entry);
    }
  }

  function receiveReset(
    sessionId: string,
    agentId: string,
    snapshot: AgentTranscriptSnapshot,
    seq?: number,
  ): void {
    if (desiredAgentBySession.get(sessionId) !== agentId) return;
    const entry = getOrCreate(sessionId, agentId);
    entry.channel.receiveReset(snapshot, seq);
    entry.baselineLoaded = true;
  }

  function applyOps(
    sessionId: string,
    agentId: string,
    ops: readonly TranscriptOperation[],
    seq?: number,
  ): boolean {
    if (desiredAgentBySession.get(sessionId) !== agentId) return true;
    return getOrCreate(sessionId, agentId).channel.applyOps(ops, seq);
  }

  function forgetSession(sessionId: string): void {
    desiredAgentBySession.delete(sessionId);
    if (subscribedAgentBySession.delete(sessionId)) {
      deps.getEventConnection()?.unsubscribeTranscript(sessionId);
    }
    for (const [key, entry] of entries) {
      if (entry.channel.sessionId === sessionId) {
        entries.delete(key);
        dirtyEntries.delete(entry);
      }
    }
  }

  return {
    getEntry: (sessionId: string, agentId: string) => entries.get(keyOf(sessionId, agentId)),
    /** The agent whose transcript the detail system currently wants per
     *  session (BTW or the open detail panel's) — read-only, reactive. */
    desiredAgentBySession: desiredAgentBySession as ReadonlyMap<string, string>,
    activate,
    deactivate,
    receiveReset,
    applyOps,
    forgetSession,
  };
}
