/**
 * `SubagentRosterTracker` — accumulates the per-session roster of live
 * subagent tasks so a reconnecting client can rebuild swarm cards from the
 * session snapshot. The refresh flow subscribes at the snapshot watermark, so
 * earlier `subagent.spawned` events — the only carriers of the swarm identity
 * metadata — are never replayed to it.
 *
 * Ported from v1 (`packages/server/src/services/gateway/subagentRosterTracker.ts`),
 * with two adaptations: a swarm member's own `turn.ended` never clears the
 * roster (every agent's events flow through the same per-session dispatch
 * queue here, unlike v1's firehose), and the main agent's `turn.ended` does
 * not clear it either — the swarm result is only queued for the async wire
 * append at that point, so clearing there would open a window where a
 * reconnecting client sees neither the roster nor the transcript result.
 *
 * Without this roster a mid-swarm page refresh loses the swarm card's member
 * list: REST `/tasks` only serves the main agent's background-task store
 * (foreground swarm subagents never persist there), and later `subagent.*`
 * events carry only the `subagentId`, so the identity metadata
 * (`parentToolCallId` / `swarmIndex` / `description`) is unrecoverable until
 * the swarm's `<agent_swarm_result>` tool output lands.
 *
 * Owned by the `SessionEventBroadcaster` and updated INSIDE its per-session
 * dispatch queue — same pattern as `InFlightTurnTracker`, keeping the roster,
 * the journal watermark, and the fan-out order mutually consistent.
 *
 * Lifetime: the roster is dropped when the main agent starts its NEXT turn —
 * the previous turn's result record was queued for the async wire append
 * before `turn.ended`, so by then it is durable in practice and the
 * transcript takes over as the restore source (a queued/cron follow-up turn
 * can still start inside the ms-scale flush gap; that window self-heals on
 * the next refresh). If the main turn
 * aborts (cancelled / failed / blocked), still-live entries are finalized as
 * failed at `turn.ended` instead: the swarm dies with the turn and the abort
 * path suppresses the members' own `subagent.failed` events. Background
 * subagents (`run_in_background`) are excluded by design: they persist in the
 * background-task store and are served by REST `/tasks`, so listing them here
 * would duplicate the row after a refresh.
 */

import type { Event } from './events';
import type { SnapshotSubagent } from '../../../protocol/rest-snapshot';

const MAIN_AGENT_ID = 'main';

export class SubagentRosterTracker {
  private readonly bySession = new Map<string, Map<string, SnapshotSubagent>>();

  apply(sessionId: string, event: Event): void {
    switch (event.type) {
      case 'subagent.spawned': {
        // Background subagents persist in the main agent's background-task
        // store and come back through REST `/tasks` after a refresh (keyed by
        // task id) — tracking them here too would duplicate the row (keyed by
        // agent id) and mis-target cancel/detail actions. The roster exists
        // for the foreground/live-only subagents REST cannot serve.
        if (event.runInBackground === true) return;
        let roster = this.bySession.get(sessionId);
        if (!roster) {
          roster = new Map();
          this.bySession.set(sessionId, roster);
        }
        roster.set(event.subagentId, {
          id: event.subagentId,
          session_id: sessionId,
          kind: 'subagent',
          description: event.description ?? event.subagentName ?? 'Sub Agent',
          status: 'running',
          subagent_phase: 'queued',
          subagent_type: event.subagentName,
          parent_tool_call_id: event.parentToolCallId === '' ? undefined : event.parentToolCallId,
          swarm_index: event.swarmIndex,
          run_in_background: event.runInBackground,
          created_at: new Date().toISOString(),
        });
        return;
      }
      case 'subagent.started': {
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry) return;
        entry.subagent_phase = 'working';
        entry.suspended_reason = undefined;
        // Keep an existing started_at: a resumed (previously suspended)
        // subagent re-fires `subagent.started`.
        entry.started_at ??= new Date().toISOString();
        return;
      }
      case 'subagent.suspended': {
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry) return;
        entry.subagent_phase = 'suspended';
        entry.suspended_reason = event.reason;
        return;
      }
      case 'subagent.completed': {
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry) return;
        entry.subagent_phase = 'completed';
        entry.status = 'completed';
        entry.completed_at = new Date().toISOString();
        entry.output_preview = event.resultSummary;
        return;
      }
      case 'subagent.failed': {
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry) return;
        entry.subagent_phase = 'failed';
        entry.status = 'failed';
        entry.completed_at = new Date().toISOString();
        entry.output_preview = event.error;
        return;
      }
      case 'task.started': {
        // A foreground subagent that detaches (Ctrl+B / timeout) re-enters as
        // a detached background task served by REST `/tasks` under a new task
        // id — drop its roster entry so a refresh doesn't seed both the roster
        // row (agent id) and the REST row (task id). Registration of a
        // background spawn emits the same event, but those were never tracked
        // here, so the delete is a no-op for them.
        const info = event.info;
        if (info.kind === 'agent' && info.detached === true && info.agentId !== undefined) {
          this.bySession.get(sessionId)?.delete(info.agentId);
        }
        return;
      }
      case 'turn.ended': {
        if (event.agentId !== MAIN_AGENT_ID) return;
        const roster = this.bySession.get(sessionId);
        if (roster === undefined || event.reason === 'completed') return;
        // Aborted main turn (cancelled / failed / blocked): the swarm dies
        // with it, and the abort path suppresses the members' own
        // `subagent.failed` events — finalize any still-live entries here so a
        // refresh doesn't seed phantom `running` subagents that no later
        // lifecycle event would correct. The roster itself stays until the
        // next main `turn.started`, same as the completed path.
        for (const entry of roster.values()) {
          if (entry.status !== 'running') continue;
          entry.status = 'failed';
          entry.subagent_phase = 'failed';
          entry.completed_at = new Date().toISOString();
          entry.output_preview ??= `Main turn ${event.reason}`;
        }
        return;
      }
      case 'turn.started': {
        // Settle the roster when the main agent starts a NEW turn. The result
        // record is queued for the async wire append before `turn.ended`, so
        // by the next turn it is durable in practice; a queued/cron follow-up
        // can still start inside the flush gap, but that window is ms-scale
        // and self-heals on the next refresh once the flush lands. (Fully
        // closing it needs the snapshot reader to read through the agent
        // append log — deliberately left out of this change.) A subagent's
        // own turn boundaries must never drop the roster mid-swarm.
        if (event.agentId === MAIN_AGENT_ID) {
          this.bySession.delete(sessionId);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Fresh copies — callers must not mutate the tracked entries. */
  get(sessionId: string): SnapshotSubagent[] {
    const roster = this.bySession.get(sessionId);
    if (!roster) return [];
    return Array.from(roster.values(), (entry) => ({ ...entry }));
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
