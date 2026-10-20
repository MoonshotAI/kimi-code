import { createFeature, useAgent } from '@moonshot-ai/agent-core/app/index';
import {
  createFacadeToken,
  useCleanup,
  useExpose,
  useFire,
  useInject,
  type ShallowRef,
} from '@moonshot-ai/agent-core/kernel/index';

import { openInteractions, type InteractionEvent, type Interactions } from './interaction';

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
    const agent = useAgent();
    useCleanup(() => {
      interactions.cancelAgent(agent.id, 'agent_closed');
    });
  },
});
