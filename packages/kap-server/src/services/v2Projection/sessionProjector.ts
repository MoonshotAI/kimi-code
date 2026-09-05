import type { ServerMessage } from '../../protocol/v2/messages/index';
import {
  AgentV2Projector,
  type InteractionPendingRecord,
  type InteractionResolvedRecord,
  type ProjectionEvent,
} from './agentProjector';
import { SessionStateComposer, type SessionFactsPatch } from './sessionStateComposer';

export class SessionV2Projector {
  private readonly agents = new Map<string, AgentV2Projector>();
  readonly composer: SessionStateComposer;

  constructor(readonly sessionId: string) {
    this.composer = new SessionStateComposer(sessionId);
  }

  agentFor(agentId: string): AgentV2Projector {
    let projector = this.agents.get(agentId);
    if (!projector) {
      const turnIdPrefix = agentId === 'main' || agentId.startsWith('side_') ? 't' : 'r';
      projector = new AgentV2Projector(this.sessionId, agentId, turnIdPrefix);
      this.agents.set(agentId, projector);
    }
    return projector;
  }

  applyAgentEvent(agentId: string, event: ProjectionEvent): ServerMessage[] {
    return this.agentFor(agentId).apply(event);
  }

  applyInteractionPending(agentId: string, record: InteractionPendingRecord): ServerMessage[] {
    return this.agentFor(agentId).applyInteractionPending(record);
  }

  applyInteractionResolved(agentId: string, record: InteractionResolvedRecord): ServerMessage[] {
    return this.agentFor(agentId).applyInteractionResolved(record);
  }

  applyFacts(patch: SessionFactsPatch, time: number, flushTexts = true): ServerMessage[] {
    const out: ServerMessage[] = [];
    if (flushTexts) {
      for (const agent of this.agents.values()) out.push(...agent.flushOpenTexts(time));
    }
    this.composer.apply(patch);
    const msg = this.composer.compose(time, (turnId, step) => `t${turnId + 1}.${step}`);
    if (msg) out.push(msg);
    return out;
  }
}
