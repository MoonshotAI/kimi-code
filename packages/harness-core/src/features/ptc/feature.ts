import {
  AgentPort,
  createFeature,
  useAgent,
  useAgentStore,
  useAgentTools,
  useBlobs,
  useInject,
  useSession,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';

import type { PtcContextLevel } from './context';
import { createCodeTool, DEFAULT_PTC_LIMITS, type PtcLimits } from './tool';

export const PTC_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_PTC';
export const EXPERIMENTAL_MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

export interface CreatePtcProps {
  readonly dir: string;
  readonly exclude?: readonly string[];
  readonly limits?: Partial<PtcLimits>;
  readonly context?: PtcContextLevel;
  readonly enabled?: () => boolean;
}

export function createPtc(props: CreatePtcProps): FeatureSpec {
  const exclude = new Set(props.exclude ?? []);
  const limits: PtcLimits = { ...DEFAULT_PTC_LIMITS, ...props.limits };
  const contextLevel = props.context ?? 'none';
  const enabled = props.enabled ?? defaultEnabled;
  return createFeature('ptc', {
    agent() {
      if (!enabled()) return;
      const agent = useAgent();
      useAgentTools(
        createCodeTool({
          ports: useInject(AgentPort),
          dir: props.dir,
          agentId: agent.agentId,
          exclude,
          limits,
          contextLevel,
          contextDeps: {
            agent,
            store: useAgentStore(),
            blobs: useBlobs(),
            session: useSession(),
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
