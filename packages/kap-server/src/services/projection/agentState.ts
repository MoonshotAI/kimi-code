import type { AgentActivitySnapshot, AgentTaskInfo } from '@moonshot-ai/agent-core-v2';

import type {
  AgentStateMessage,
  AgentStateOrigin,
  AgentStateTurn,
  AgentStatus,
} from '../../protocol/messages';

const TERMINAL_STATUSES: ReadonlySet<AgentStatus> = new Set(['completed', 'failed', 'interrupted']);

export class AgentStateTracker {
  private origin: AgentStateOrigin | undefined;
  private profileKind = '';
  private createdAt: string;
  private endedAt: string | undefined;
  private status: AgentStatus = 'idle';
  private turn: AgentStateTurn | undefined;

  constructor(
    readonly agentId: string,
    createdAt?: string,
  ) {
    this.createdAt = createdAt ?? new Date().toISOString();
  }

  get hasOrigin(): boolean {
    return this.origin !== undefined;
  }

  seedMain(profileKind: string, createdAt: string, running: boolean): void {
    this.origin = { kind: 'main' };
    this.profileKind = profileKind;
    this.createdAt = createdAt;
    if (running) this.status = 'running';
  }

  seedBtw(profileKind: string, createdAt: string, running: boolean): void {
    this.origin = { kind: 'btw' };
    this.profileKind = profileKind;
    this.createdAt = createdAt;
    if (running) this.status = 'running';
  }

  seedToolSpawned(event: {
    subagentId: string;
    subagentName: string;
    parentToolCallId: string;
    parentAgentId?: string;
    swarmIndex?: number;
  }): boolean {
    if (event.subagentId !== this.agentId || event.parentToolCallId.length === 0) return false;
    const origin: AgentStateOrigin =
      event.swarmIndex !== undefined
        ? {
            kind: 'tool-swarm',
            tool_call_id: event.parentToolCallId,
            swarm_index: event.swarmIndex,
            parent_agent_id: event.parentAgentId ?? 'main',
          }
        : {
            kind: 'tool-agent',
            tool_call_id: event.parentToolCallId,
            parent_agent_id: event.parentAgentId ?? 'main',
          };
    if (JSON.stringify(this.origin) === JSON.stringify(origin)) return false;
    this.origin = origin;
    this.profileKind = event.subagentName;
    return true;
  }

  seedToolFromTask(profileKind: string, createdAt: string, info: AgentTaskInfo | undefined): boolean {
    const agentInfo = info === undefined ? undefined : agentInfoOfTask(info);
    const toolCallId = agentInfo?.parentToolCallId;
    if (toolCallId === undefined || toolCallId.length === 0) return false;
    this.origin = {
      kind: 'tool-agent',
      tool_call_id: toolCallId,
      parent_agent_id: 'main',
    };
    this.profileKind = profileKind;
    this.createdAt = createdAt;
    return true;
  }

  turnStarted(): boolean {
    if (this.status === 'running') return false;
    this.status = 'running';
    this.endedAt = undefined;
    return true;
  }

  turnEnded(): boolean {
    if (this.status !== 'running') return false;
    this.status = 'idle';
    this.turn = undefined;
    return true;
  }

  runStarted(): boolean {
    return this.turnStarted();
  }

  runFinished(status: 'completed' | 'failed', endedAt: string): boolean {
    if (this.status === status) return false;
    this.status = status;
    this.turn = undefined;
    this.endedAt = endedAt;
    return true;
  }

  close(endedAt: string): boolean {
    if (this.endedAt !== undefined) return false;
    this.endedAt = endedAt;
    this.turn = undefined;
    if (TERMINAL_STATUSES.has(this.status)) return true;
    this.status = 'interrupted';
    return true;
  }

  recompute(snapshot: AgentActivitySnapshot): boolean {
    if (TERMINAL_STATUSES.has(this.status) && snapshot.turn === undefined) return false;
    const turn = snapshot.turn;
    if (turn === undefined) {
      const changed = this.status === 'running' || this.turn !== undefined;
      if (this.status === 'running') this.status = 'idle';
      this.turn = undefined;
      return changed;
    }
    if (this.status === 'idle') this.status = 'running';
    const next: AgentStateTurn = {
      status: turn.ending
        ? 'aborting'
        : turn.phase === 'retrying'
          ? 'retrying'
          : turn.phase === 'tool_call'
            ? 'acting'
            : 'thinking',
    };
    if (this.turn?.status === next.status) return false;
    this.turn = next;
    return true;
  }

  snapshot(sessionId: string): AgentStateMessage | undefined {
    if (this.origin === undefined) return undefined;
    return {
      type: 'agent.state',
      session_id: sessionId,
      agent_id: this.agentId,
      profile: { kind: this.profileKind },
      timestamp: Date.now(),
      origin: this.origin,
      created_at: this.createdAt,
      ended_at: this.endedAt,
      status: this.status,
      turn: this.turn,
    };
  }
}

function agentInfoOfTask(info: AgentTaskInfo): { parentToolCallId?: string } | undefined {
  if (info.kind !== 'agent') return undefined;
  return info as { parentToolCallId?: string };
}
