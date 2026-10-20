import { createFeature, useAgent, useSession, type Feature } from '@moonshot-ai/agent-core/app/index';
import { useCollection } from '@moonshot-ai/agent-core/kernel/index';
import type { Projection } from '@moonshot-ai/agent-core/store/index';

import {
  useAgentRuntime,
  useAgentTools,
  useBlobs,
  useFeatureStore,
  type FeatureEvent,
  type FeatureStore,
} from '#/runtime/index';

import type { PtcContextLevel, PtcStoreState } from './context';
import { PtcToolGuards } from './guards';
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

const ptcProjection: Projection<PtcStoreState, FeatureEvent> = {
  initial: () => ({ dispatches: 0 }),
  reduce: (state) => ({ dispatches: state.dispatches + 1 }),
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
      const guards = useCollection(PtcToolGuards);
      const store: FeatureStore<PtcStoreState, FeatureEvent> | undefined =
        contextLevel === 'full' ? useFeatureStore('agent', 'ptc', ptcProjection) : undefined;
      useAgentTools(
        createCodeTool({
          runtime,
          guards,
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
