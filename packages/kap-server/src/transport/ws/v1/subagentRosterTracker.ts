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
 * Lifetime: foreground entries are dropped when the main agent starts its
 * NEXT turn, after the preceding result has had time to enter the transcript.
 * If the main turn aborts (cancelled / failed / blocked), still-live
 * foreground entries are finalized as failed at `turn.ended` instead. Live
 * work under a background-owned subtree remains through main-turn boundaries
 * until its lifecycle event settles it; terminal entries clear at a later
 * main-turn start. Background tasks owned by the main agent are served by REST
 * `/tasks` and are never tracked here.
 */

import type { Event } from './events';
import type { SnapshotSubagent } from '../../../protocol/rest-snapshot';

const MAIN_AGENT_ID = 'main';

export interface SubagentRosterAnnotation {
  readonly mainTurnIndependent: boolean;
}

export class SubagentRosterTracker {
  private readonly bySession = new Map<string, Map<string, SnapshotSubagent>>();
  private readonly mainTurnIndependentAgents = new Map<string, Set<string>>();

  apply(sessionId: string, event: Event): SubagentRosterAnnotation | undefined {
    switch (event.type) {
      case 'subagent.spawned': {
        let independentAgents = this.mainTurnIndependentAgents.get(sessionId);
        if (independentAgents === undefined) {
          independentAgents = new Set();
          this.mainTurnIndependentAgents.set(sessionId, independentAgents);
        }
        const mainTurnIndependent =
          event.runInBackground === true || independentAgents.has(event.agentId);
        if (mainTurnIndependent) independentAgents.add(event.subagentId);
        else independentAgents.delete(event.subagentId);
        const annotation = { mainTurnIndependent };

        // REST `/tasks` only exposes the main agent's background-task store.
        // A background task launched by a nested agent therefore still needs
        // the roster to survive a reconnect.
        if (event.runInBackground === true && event.agentId === MAIN_AGENT_ID) return annotation;
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
          main_turn_independent: mainTurnIndependent,
          created_at: new Date().toISOString(),
        });
        return annotation;
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
        this.mainTurnIndependentAgents.get(sessionId)?.delete(event.subagentId);
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry) return;
        entry.subagent_phase = 'completed';
        entry.status = 'completed';
        entry.completed_at = new Date().toISOString();
        entry.output_preview = event.resultSummary;
        return;
      }
      case 'subagent.failed': {
        this.mainTurnIndependentAgents.get(sessionId)?.delete(event.subagentId);
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry) return;
        entry.subagent_phase = 'failed';
        entry.status = 'failed';
        entry.completed_at = new Date().toISOString();
        entry.output_preview = event.error;
        return;
      }
      case 'task.started': {
        // The REST task surface reaches only the main agent. A detached child
        // task remains roster-owned; mark it background so it survives a main
        // turn boundary. A main-owned detached task is represented by REST
        // under its task id, so drop its agent-id roster entry.
        const info = event.info;
        if (info.kind === 'agent' && info.detached === true && info.agentId !== undefined) {
          let independentAgents = this.mainTurnIndependentAgents.get(sessionId);
          if (independentAgents === undefined) {
            independentAgents = new Set();
            this.mainTurnIndependentAgents.set(sessionId, independentAgents);
          }
          independentAgents.add(info.agentId);
          const roster = this.bySession.get(sessionId);
          if (event.agentId === MAIN_AGENT_ID) {
            roster?.delete(info.agentId);
          } else {
            const entry = roster?.get(info.agentId);
            if (entry !== undefined) {
              entry.run_in_background = true;
              entry.main_turn_independent = true;
            }
          }
        }
        return;
      }
      case 'turn.ended': {
        if (event.agentId !== MAIN_AGENT_ID) return;
        const roster = this.bySession.get(sessionId);
        if (roster === undefined || event.reason === 'completed') return;
        // Aborted main turn (cancelled / failed / blocked): main-bound work
        // dies with it. A background-owned subtree is independent and keeps
        // its own terminal lifecycle event, so it must stay live in the roster.
        for (const entry of roster.values()) {
          if (entry.status !== 'running' || entry.main_turn_independent === true) continue;
          entry.status = 'failed';
          entry.subagent_phase = 'failed';
          entry.completed_at = new Date().toISOString();
          entry.output_preview ??= `Main turn ${event.reason}`;
        }
        return;
      }
      case 'turn.started': {
        // Settle foreground roster entries when the main agent starts a NEW
        // turn. Keep still-running background-owned work: it can legitimately
        // outlive the main turn and REST cannot read its owner-local task store.
        if (event.agentId === MAIN_AGENT_ID) {
          const roster = this.bySession.get(sessionId);
          if (roster === undefined) return;
          for (const [id, entry] of roster) {
            if (entry.main_turn_independent !== true || entry.status !== 'running') {
              roster.delete(id);
            }
          }
          if (roster.size === 0) this.bySession.delete(sessionId);
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
    this.mainTurnIndependentAgents.delete(sessionId);
  }
}
