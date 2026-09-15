import type { AgentActivitySnapshot, AgentTaskInfo } from '@moonshot-ai/agent-core-v2';

import type {
  AgentFinishReason,
  AgentStateMessage,
  AgentStateOrigin,
  AgentStatus,
} from '../../protocol/messages';

export class AgentStateTracker {
  private origin: AgentStateOrigin | undefined;
  private profileKind = '';
  private createdAt: string;
  private endedAt: string | undefined;
  private finishReason: AgentFinishReason | undefined;
  private running = false;
  private compacting = false;

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
    this.running = running;
  }

  seedBtw(profileKind: string, createdAt: string, running: boolean): void {
    this.origin = { kind: 'btw' };
    this.profileKind = profileKind;
    this.createdAt = createdAt;
    this.running = running;
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
    const toolCallId = agentInfo === undefined ? undefined : (agentInfo.parentToolCallId ?? agentInfo.taskId);
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
    if (this.running) return false;
    this.running = true;
    this.endedAt = undefined;
    this.finishReason = undefined;
    return true;
  }

  turnEnded(): boolean {
    if (!this.running) return false;
    this.running = false;
    this.compacting = false;
    return true;
  }

  compactionStarted(): boolean {
    if (this.compacting) return false;
    this.compacting = true;
    return true;
  }

  compactionEnded(): boolean {
    if (!this.compacting) return false;
    this.compacting = false;
    return true;
  }

  runStarted(): boolean {
    return this.turnStarted();
  }

  runFinished(reason: 'completed' | 'failed' | 'interrupted', endedAt: string): boolean {
    if (this.finishReason === reason) return false;
    this.finishReason = reason;
    this.running = false;
    this.compacting = false;
    this.endedAt = endedAt;
    return true;
  }

  close(endedAt: string): boolean {
    if (this.endedAt !== undefined) return false;
    this.endedAt = endedAt;
    this.running = false;
    this.compacting = false;
    if (this.finishReason !== undefined) return true;
    this.finishReason = 'interrupted';
    return true;
  }

  recompute(snapshot: AgentActivitySnapshot): boolean {
    if (snapshot.turn === undefined) {
      if (this.finishReason !== undefined) return false;
      if (!this.running) return false;
      this.running = false;
      return true;
    }
    if (this.running) return false;
    this.running = true;
    return true;
  }

  snapshot(sessionId: string): AgentStateMessage | undefined {
    if (this.origin === undefined) return undefined;
    const status: AgentStatus = this.compacting ? 'compacting' : this.running ? 'running' : 'idle';
    return {
      type: 'agent.state',
      session_id: sessionId,
      agent_id: this.agentId,
      profile: { kind: this.profileKind },
      event_created_at: new Date().toISOString(),
      origin: this.origin,
      created_at: this.createdAt,
      ended_at: this.endedAt,
      status,
      finish_reason: this.finishReason,
    };
  }
}

function agentInfoOfTask(info: AgentTaskInfo): { taskId: string; parentToolCallId?: string } | undefined {
  if (info.kind !== 'agent') return undefined;
  return info;
}
