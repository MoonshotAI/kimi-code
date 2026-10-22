import { createFeature, useAgent, useSession, type Feature, useAgentRuntime, useAgentTools, useBlobs, useFeatureStore } from '#/app/index';
import type { Projection } from '@moonshot-ai/agent-core/store/index';

import type { PtcContextLevel, PtcDispatchedEvent, PtcStoreState } from './context';
import { PTC_DISPATCHED } from './context';
import { createCodeTool, DEFAULT_PTC_LIMITS, type PtcLimits } from './tool';
import type { FeatureStore } from '#/app/index';

export const PTC_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_PTC';

const _EXPERIMENTAL_PTC = false;

export interface CreatePtcProps {
  readonly dir: string;
  readonly exclude?: readonly string[];
  readonly limits?: Partial<PtcLimits>;
  readonly context?: PtcContextLevel;
  readonly enabled?: () => boolean;
  readonly EXPERIMENTAL_PTC?: boolean;
}

const ptcProjection: Projection<PtcStoreState, PtcDispatchedEvent> = {
  initial: () => ({ dispatches: 0 }),
  reduce: (state, entry) => {
    if (entry.event.type !== PTC_DISPATCHED) return state;
    return { dispatches: state.dispatches + entry.event.events.length };
  },
};

export function createPtc(props: CreatePtcProps): Feature<void> {
  const exclude = new Set(props.exclude ?? []);
  const limits: PtcLimits = { ...DEFAULT_PTC_LIMITS, ...props.limits };
  const contextLevel = props.context ?? 'none';
  const enabled = props.enabled ?? (() => props.EXPERIMENTAL_PTC ?? _EXPERIMENTAL_PTC);
  return createFeature('ptc', {
    agent() {
      if (!enabled()) return;
      const agent = useAgent();
      const runtime = useAgentRuntime();
      const store: FeatureStore<PtcStoreState, PtcDispatchedEvent> | undefined =
        contextLevel === 'full' ? useFeatureStore('agent', 'ptc', ptcProjection) : undefined;
      useAgentTools(
        createCodeTool({
          runtime,
          dir: props.dir,
          agentId: agent.id,
          exclude,
          limits,
          contextLevel,
          contextDeps: {
            agent,
            session: useSession(),
            blobs: useBlobs(),
            store,
          },
        }),
      );
    },
  });
}
