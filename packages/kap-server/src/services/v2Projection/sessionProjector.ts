import type { ServerMessage } from '../../protocol/v2/messages/index';
import { AgentV2Projector, type ProjectionEvent } from './agentProjector';
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
      projector = new AgentV2Projector(this.sessionId, agentId);
      this.agents.set(agentId, projector);
    }
    return projector;
  }

  applyAgentEvent(agentId: string, event: ProjectionEvent): ServerMessage[] {
    return this.agentFor(agentId).apply(event);
  }

  applyFacts(patch: SessionFactsPatch, time: number): ServerMessage[] {
    this.composer.apply(patch);
    const msg = this.composer.compose(time, (turnId, step) => `t${turnId + 1}.${step}`);
    return msg ? [msg] : [];
  }
}
