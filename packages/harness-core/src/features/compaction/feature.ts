import {
  createFeature,
  useAgent,
  useRequester,
  useStepStarting,
  useStepStopping,
  type Feature,
} from '@moonshot-ai/agent-core/app/index';
import { createFacadeToken, useCleanup, useExpose, useFire } from '@moonshot-ai/agent-core/kernel/index';

import { useLoopEvent } from '#/runtime/index';

import {
  createCompactionController,
  type CompactionController,
  type CompactionControllerDeps,
  type CompactionEvent,
} from './controller';
import { createSummarize, type Summarize } from './summarize';

export type CompactionFace = Pick<CompactionController, 'compact' | 'cancel' | 'status'>;

export const CompactionRef = createFacadeToken<CompactionFace>('compaction');

export type CreateCompactionDeps = Omit<CompactionControllerDeps, 'agent' | 'emit' | 'summarize'> & {
  summarize?: Summarize;
  onEvent?: (event: CompactionEvent) => void;
};

export function createCompaction(deps: CreateCompactionDeps): Feature<void, CompactionEvent> {
  return createFeature<CompactionEvent>('compaction', {
    agent() {
      const agent = useAgent();
      const fire = useFire();
      const controller = createCompactionController({
        ...deps,
        summarize: deps.summarize ?? createSummarize({ requester: useRequester() }),
        agent,
        emit: (event) => {
          deps.onEvent?.(event);
          fire({ ...event });
        },
      });
      useStepStarting((event, signal) => controller.stepStarting(event, signal), {
        id: 'compaction.step-starting',
      });
      useStepStopping((event) => controller.stepStopping(event), {
        id: 'compaction.step-stopping',
      });
      useLoopEvent('llm.ended', ({ outcome }) => controller.noteLlmOutcome(outcome));
      useLoopEvent('turn.ended', ({ outcome }) => controller.noteTurnEnded(outcome));
      useExpose(CompactionRef, {
        compact: (instruction) => controller.compact(instruction),
        cancel: () => controller.cancel(),
        status: () => controller.status(),
      });
      useCleanup(() => controller.dispose());
    },
  });
}
