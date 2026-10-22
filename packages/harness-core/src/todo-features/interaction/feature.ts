import { createFeature, useAgent, useSession, useAgentTools, type Feature } from '#/app/index';
import {
  createFacadeToken,
  useCleanup,
  useExpose,
  useFire,
  useInject,
  type ShallowRef,
} from '#/composition-api/index';

import { TelemetryRef, useTelemetryEvents } from '#/todo-features/telemetry/index';

import { openInteractions, type InteractionEvent, type Interactions } from './interaction';
import { useAskUserQuestionAutoMode } from './permission-mode';
import { createAskUserQuestionTool, questionTelemetryEvents } from './tools/ask-user-question';

export const InteractionRef = createFacadeToken<Interactions>('interaction');

export function useInteractions(): Readonly<ShallowRef<Interactions | undefined>> {
  return useInject(InteractionRef);
}

const _PERMISSION_MODE_REMINDER = true;

export interface CreateInteractionProps {
  readonly PERMISSION_MODE_REMINDER?: boolean;
}

export function createInteraction(
  props: CreateInteractionProps = {},
): Feature<void, { session: InteractionEvent }> {
  return createFeature<{ session: InteractionEvent }>('interaction', {
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
      useAskUserQuestionAutoMode(props.PERMISSION_MODE_REMINDER ?? _PERMISSION_MODE_REMINDER);
      useCleanup(() => {
        interactions.cancelAgent(agent.id, 'agent_closed');
      });
    },
  });
}
