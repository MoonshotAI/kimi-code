import { createFeature, useAgent, useSession, useAgentTools } from '#/app/index';
import {
  createFacadeToken,
  useCleanup,
  useExpose,
  useFire,
  useInject,
  type ShallowRef,
} from '#/kernel/index';

import { TelemetryRef, useTelemetryEvents } from '#/todo-features/telemetry/index';

import { openInteractions, type InteractionEvent, type Interactions } from './interaction';
import { useAskUserQuestionAutoMode } from './permission-mode';
import { createAskUserQuestionTool, questionTelemetryEvents } from './tools/ask-user-question';

export const InteractionRef = createFacadeToken<Interactions>('interaction');

export function useInteractions(): Readonly<ShallowRef<Interactions | undefined>> {
  return useInject(InteractionRef);
}

export const interaction = createFeature<{ session: InteractionEvent }>('interaction', {
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
    const telemetry = useInject(TelemetryRef);
    useTelemetryEvents(questionTelemetryEvents);
    useAgentTools(
      createAskUserQuestionTool({
        interactions,
        sessionId: useSession().id,
        agentId: agent.id,
        track: (event, properties) => telemetry.value?.track(event, properties),
      }),
    );
    useAskUserQuestionAutoMode();
    useCleanup(() => {
      interactions.cancelAgent(agent.id, 'agent_closed');
    });
  },
});
