import {
  createFacadeToken,
  createFeature,
  useAgent,
  useAgentTools,
  useCleanup,
  useInject,
  useSession,
} from '@moonshot-ai/agent-core';
import { useExpose, useFire, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';

import { openInteractions, type InteractionEvent, type Interactions } from './interaction';
import { createAskUserQuestionTool } from './tool';

export const InteractionRef = createFacadeToken<Interactions>('interaction');

export function useInteractions(): Readonly<ShallowRef<Interactions | undefined>> {
  return useInject(InteractionRef);
}

export const interaction = createFeature<InteractionEvent>('interaction', {
  session() {
    const fire = useFire();
    const interactions = openInteractions({ fire });
    useExpose(InteractionRef, interactions);
    useCleanup(() => interactions.stop());
  },
  agent() {
    const interactions = useInteractions().value;
    if (interactions === undefined) {
      throw new Error('interaction feature session slot is not installed');
    }
    const session = useSession();
    const agent = useAgent();
    useAgentTools(
      createAskUserQuestionTool(interactions, {
        sessionId: session.sessionId,
        agentId: agent.agentId,
      }),
    );
    useCleanup(() => {
      interactions.cancelAgent(agent.agentId, 'agent_closed');
    });
  },
});
