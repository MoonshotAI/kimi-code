import { createFeature, useAgent, useAgentTools, useSession } from '@moonshot-ai/agent-core';
import {
  createToken,
  inject,
  pushCleanup,
  useExpose,
  useFire,
  useNode,
} from '@moonshot-ai/agent-core/kernel/index';

import { openInteractions, type Interactions } from './interaction';
import { createAskUserQuestionTool } from './tool';

export const InteractionRef = createToken<Interactions>('interaction');

export function useInteractions(): Interactions {
  return inject(InteractionRef);
}

export const interaction = createFeature('interaction', {
  session() {
    const fire = useFire();
    const interactions = openInteractions({ fire });
    useExpose(InteractionRef, interactions);
    pushCleanup(useNode(), () => interactions.stop());
  },
  agent() {
    const interactions = useInteractions();
    const session = useSession();
    const agent = useAgent();
    useAgentTools(
      createAskUserQuestionTool(interactions, {
        sessionId: session.sessionId,
        agentId: agent.agentId,
      }),
    );
    pushCleanup(useNode(), () => {
      interactions.cancelAgent(agent.agentId, 'agent_closed');
    });
  },
});
