import {
  createFacadeToken,
  createFeature,
  useAgent,
  useBeforeStep,
  useCleanup,
  useSession,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';
import { useExpose } from '@moonshot-ai/agent-core/kernel/index';

import {
  createCompactionController,
  type CompactionController,
  type CompactionControllerDeps,
} from './controller';

export type CompactionFace = Pick<CompactionController, 'compact' | 'cancel' | 'status'>;

export const CompactionRef = createFacadeToken<CompactionFace>('compaction');

export type CreateCompactionDeps = Omit<CompactionControllerDeps, 'agentId' | 'agent' | 'stores'>;

export function createCompaction(deps: CreateCompactionDeps): FeatureSpec {
  return createFeature('compaction', {
    agent() {
      const agent = useAgent();
      const session = useSession();
      const controller = createCompactionController({
        ...deps,
        agentId: agent.agentId,
        agent,
        stores: session.stores,
      });
      useBeforeStep(controller.onBeforeStep);
      useExpose(CompactionRef, {
        compact: (instruction) => controller.compact(instruction),
        cancel: () => controller.cancel(),
        status: () => controller.status(),
      });
      useCleanup(() => controller.dispose());
    },
  });
}
