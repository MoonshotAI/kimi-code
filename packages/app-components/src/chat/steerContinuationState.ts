import { reactive } from 'vue';
import type { ChatTurn } from '@moonshot-ai/app-core/client/types';
import { turnHasOutput } from '../chatTurnRendering';

const MAX_TRACKED_SESSIONS = 64;
const STORAGE_KEY = 'kimi-web.settled-steer-turns';
const settledBySession = new Map<string, Set<string>>();

function readStoredMap(): Record<string, string[]> {
  try {
    if (typeof sessionStorage === 'undefined') return {};
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [sid, ids] of Object.entries(parsed)) {
      if (Array.isArray(ids)) {
        const valid = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (valid.length > 0) out[sid] = valid;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStoredSession(sessionId: string, ids: Set<string>): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const stored = readStoredMap();
    delete stored[sessionId];
    if (ids.size > 0) {
      stored[sessionId] = [...ids];
    }
    const keys = Object.keys(stored);
    while (keys.length > MAX_TRACKED_SESSIONS) {
      const oldest = keys.shift();
      if (oldest !== undefined) delete stored[oldest];
    }
    if (Object.keys(stored).length === 0) {
      sessionStorage.removeItem(STORAGE_KEY);
    } else {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    }
  } catch {
    return;
  }
}

function sessionSet(sessionId: string): Set<string> {
  let set = settledBySession.get(sessionId);
  if (set !== undefined) {
    settledBySession.delete(sessionId);
    settledBySession.set(sessionId, set);
    return set;
  }
  const hydrated = readStoredMap()[sessionId] ?? [];
  set = reactive(new Set<string>(hydrated));
  settledBySession.set(sessionId, set);
  while (settledBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = settledBySession.keys().next().value;
    if (oldest === undefined) break;
    settledBySession.delete(oldest);
  }
  return set;
}

export function settledSteerTurnIdsFor(
  sessionId: string | null | undefined,
  fallback: Set<string>,
): Set<string> {
  return sessionId ? sessionSet(sessionId) : fallback;
}

export function syncSettledSteerTurnIds(
  sessionId: string | null | undefined,
  fallback: Set<string>,
  turns: readonly ChatTurn[],
  sessionLoading: boolean,
): void {
  const target = settledSteerTurnIdsFor(sessionId, fallback);
  const presentSteerIds = new Set<string>();
  let seenAssistantOutput = false;
  let mutated = false;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    if (turn.role === 'assistant' && turnHasOutput(turn)) {
      seenAssistantOutput = true;
      continue;
    }
    if (turn.role === 'user' && turn.steered === true) {
      presentSteerIds.add(turn.id);
      if (turn.steerPhase === 'injected' && seenAssistantOutput && !target.has(turn.id)) {
        target.add(turn.id);
        mutated = true;
      }
    }
  }
  if (sessionLoading && turns.length === 0) {
    if (sessionId && mutated) writeStoredSession(sessionId, target);
    return;
  }
  for (const id of target) {
    if (!presentSteerIds.has(id)) {
      target.delete(id);
      mutated = true;
    }
  }
  if (sessionId) {
    if (target.size === 0) settledBySession.delete(sessionId);
    if (mutated) writeStoredSession(sessionId, target);
  }
}

export function resetInMemorySettledSteerTurnIds(): void {
  settledBySession.clear();
}
