import type { Event, SessionStatus } from '@moonshot-ai/protocol';

import type { ICoreRuntime } from '#/coreProcess';
import type { CoreRPC } from '../../rpc';
import type { SessionMeta } from '../../session';

/**
 * Narrow in-process CoreAPI accessor supplied by the concrete
 * `CoreProcessService` (the sole production `ICoreRuntime`). Routed
 * through a structural cast so the public `ICoreRuntime` facade — and
 * the many test doubles that implement it across the suite — stay unchanged.
 * The daemon-side adapter always provides `getCoreApi()`; see
 * `CoreProcessService.getCoreApi` for the zero-serialization rationale.
 */
type InProcessCoreApi = { getCoreApi(): CoreRPC };

/**
 * Inputs required to derive a session's lifecycle status. Gathered by the
 * caller (SessionService for the command path, SessionQueryService for the
 * read path) from the live services and the in-memory turn-tracking sets so
 * the computation itself stays pure and side-effect-free.
 */
export interface SessionStatusInput {
  readonly awaitingApproval: boolean;
  readonly awaitingQuestion: boolean;
  readonly hasActivePrompt: boolean;
  readonly hasActiveTurn: boolean;
  readonly wasAborted: boolean;
}

/**
 * Compute the session lifecycle status from live daemon state.
 *
 * Priority (mirrors the original `SessionService._computeStatus`):
 *   1. awaiting_approval — pending approvals exist
 *   2. awaiting_question — pending questions exist
 *   3. running           — active prompt or active turn
 *   4. aborted           — last turn ended as cancelled/failed and no new work started
 *   5. idle              — everything else
 *
 * This helper is shared by `SessionService` (command path) and
 * `SessionQueryService` (read path) so the status derivation is defined in
 * exactly one place. It does not touch live agents and never resumes one.
 */
export function computeSessionStatus(input: SessionStatusInput): SessionStatus {
  if (input.awaitingApproval) {
    return 'awaiting_approval';
  }
  if (input.awaitingQuestion) {
    return 'awaiting_question';
  }
  if (input.hasActivePrompt || input.hasActiveTurn) {
    return 'running';
  }
  if (input.wasAborted) {
    return 'aborted';
  }
  return 'idle';
}

/**
 * In-memory turn-tracking state used to feed `computeSessionStatus`'s
 * `hasActiveTurn` / `wasAborted` inputs. Both `SessionService` and
 * `SessionQueryService` keep their own copy, driven by the same event-bus
 * events via `applySessionTurnEvent`, so the live status they derive stays
 * consistent without either reaching into the other's privates.
 */
export interface SessionTurnState {
  readonly activeTurns: Set<string>;
  readonly abortedTurns: Set<string>;
}

/**
 * Fold a single event-bus event into the turn-tracking sets. Only the events
 * that move `activeTurns` / `abortedTurns` are handled; everything else is a
 * no-op. Status-*change* emission stays with `SessionService` — the query
 * path calls this purely to keep its read-model status in sync.
 */
export function applySessionTurnEvent(state: SessionTurnState, event: Event): void {
  const type = (event as { type?: string }).type;
  const sessionId = (event as { sessionId?: string }).sessionId;
  if (sessionId === undefined || sessionId === '' || type === undefined) return;

  switch (type) {
    case 'turn.started': {
      state.activeTurns.add(sessionId);
      state.abortedTurns.delete(sessionId);
      break;
    }
    case 'turn.ended': {
      state.activeTurns.delete(sessionId);
      const reason = (event as { reason?: string }).reason;
      if (reason === 'cancelled' || reason === 'failed') {
        state.abortedTurns.add(sessionId);
      } else {
        state.abortedTurns.delete(sessionId);
      }
      break;
    }
    case 'prompt.submitted': {
      state.abortedTurns.delete(sessionId);
      break;
    }
  }
}

/**
 * Best-effort read of `SessionMeta` for a session. Returns `undefined` when
 * the metadata file is missing or unreadable so callers can fall back to the
 * summary row. Shared by both session services; a cold read that never
 * resumes an agent.
 */
export async function tryGetSessionMeta(
  core: ICoreRuntime,
  id: string,
): Promise<SessionMeta | undefined> {
  try {
    return await (core as unknown as InProcessCoreApi)
      .getCoreApi()
      .getSessionMetadata({ sessionId: id });
  } catch {
    return undefined;
  }
}
