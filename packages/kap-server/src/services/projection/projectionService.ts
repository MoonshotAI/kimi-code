import {
  followSessionLifecycles,
  getLiveSessionById,
  type IDisposable,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import type { ServerMessage } from '../../protocol/messages';
import {
  SessionProjection,
  type ProjectionLogger,
} from './sessionProjection';

export interface ProjectionServiceDeps {
  readonly homeDir: string;
  readonly core: Scope;
  readonly logger?: ProjectionLogger;
}

export class ProjectionService {
  private readonly live = new Map<string, SessionProjection>();

  constructor(private readonly deps: ProjectionServiceDeps) {
    followSessionLifecycles(deps.core.accessor, (service) => {
      const d1 = service.onDidCloseSession(({ sessionId }) => {
        this.dropSession(sessionId);
      });
      const d2 = service.onDidArchiveSession(({ sessionId }) => {
        this.dropSession(sessionId);
      });
      return {
        dispose: () => {
          d1.dispose();
          d2.dispose();
        },
      };
    });
  }

  forSessionLive(sessionId: string): SessionProjection | undefined {
    const existing = this.live.get(sessionId);
    if (existing !== undefined) {
      if (getLiveSessionById(this.deps.core.accessor, sessionId) !== undefined) return existing;
      this.dropSession(sessionId);
      return undefined;
    }
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    if (session === undefined) return undefined;
    let projection: SessionProjection;
    try {
      projection = new SessionProjection(sessionId, session, this.deps);
    } catch (error) {
      if (error instanceof Error && error.message === 'InstantiationService has been disposed') {
        return undefined;
      }
      throw error;
    }
    this.live.set(sessionId, projection);
    return projection;
  }

  onMessage(
    sessionId: string,
    listener: (message: ServerMessage) => void,
  ): IDisposable | undefined {
    return this.forSessionLive(sessionId)?.onMessage(listener);
  }

  recoveryMessages(sessionId: string): ServerMessage[] {
    return this.forSessionLive(sessionId)?.recoveryMessages() ?? [];
  }

  notifyContextCleared(sessionId: string, agentId: string): void {
    this.live.get(sessionId)?.notifyContextCleared(agentId);
  }

  inFlight(sessionId: string, agentId: string): { turn_id: string; step_id: string } | undefined {
    return this.forSessionLive(sessionId)?.inFlight(agentId);
  }

  dropSession(sessionId: string): void {
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    this.live.delete(sessionId);
    entry.dispose();
  }
}
