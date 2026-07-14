/**
 * `SubagentRosterTracker` — accumulates the per-session roster of live
 * subagent tasks so a reconnecting client can rebuild swarm cards from the
 * session snapshot. The refresh flow subscribes at the snapshot watermark, so
 * earlier `subagent.spawned` events — the only carriers of the swarm identity
 * metadata — are never replayed to it.
 *
 * Ported from v1 (`packages/server/src/services/gateway/subagentRosterTracker.ts`),
 * with one adaptation: the roster is dropped only on the MAIN agent's
 * `turn.ended`. Unlike v1's firehose, every agent's events flow through the
 * same per-session dispatch queue here, so a swarm member's own `turn.ended`
 * must not wipe the roster while the swarm is still running.
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
 * Lifetime: the roster is dropped on the main agent's `turn.ended`. After turn
 * end the swarm's `<agent_swarm_result>` tool output is in the wire transcript
 * and becomes the restore source; this also bounds the roster's lifetime
 * (background subagents that outlive a turn are a known, pre-existing bound —
 * same trade-off as `InFlightTurnTracker`).
 */

import type { Event, SnapshotSubagent } from '@moonshot-ai/protocol';

const MAIN_AGENT_ID = 'main';

export class SubagentRosterTracker {
  private readonly bySession = new Map<string, Map<string, SnapshotSubagent>>();

  apply(sessionId: string, event: Event): void {
    switch (event.type) {
      case 'subagent.spawned': {
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
      case 'turn.ended': {
        // Only the main agent's turn end settles the swarm: after it the
        // swarm's `<agent_swarm_result>` tool output is in the wire transcript
        // and becomes the restore source. A subagent's own `turn.ended` flows
        // through the same session queue and must not drop the roster mid-swarm.
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
