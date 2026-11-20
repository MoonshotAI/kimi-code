import { IEventService, type Scope } from '@moonshot-ai/agent-core-v2';
import { SessionMetaUpdated } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetaEvents';

export function publishSessionUpdated(core: Scope, sessionId: string): void {
  core.accessor
    .get(IEventService)
    .publish(new SessionMetaUpdated({ payload: { agentId: 'main', sessionId, patch: {} } }));
}
