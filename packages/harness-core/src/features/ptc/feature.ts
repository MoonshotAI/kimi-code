import { createFeature, useAgent, useSession, type Feature } from '#/app/index';
import type { Projection } from '@moonshot-ai/agent-core/store/index';

import {
  useAgentRuntime,
  useAgentTools,
  useBlobs,
  useFeatureStore,
  type FeatureStore,
} from '#/runtime/index';

import type { PtcContextLevel, PtcDispatchedEvent, PtcStoreState } from './context';
import { PTC_DISPATCHED } from './context';
import { createCodeTool, DEFAULT_PTC_LIMITS, type PtcLimits } from './tool';

export const PTC_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_PTC';
const EXPERIMENTAL_MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

export interface CreatePtcProps {
  readonly dir: string;
  readonly exclude?: readonly string[];
  readonly limits?: Partial<PtcLimits>;
  readonly context?: PtcContextLevel;
  readonly enabled?: () => boolean;
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
  const enabled = props.enabled ?? defaultEnabled;
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

function defaultEnabled(): boolean {
  return envFlagEnabled(PTC_FLAG_ENV) || envFlagEnabled(EXPERIMENTAL_MASTER_ENV);
}

function envFlagEnabled(name: string): boolean {
  const value = process.env[name];
  return value === 'true' || value === '1';
}
