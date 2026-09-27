import {
  createFeature,
  useAgent,
  useAgentTools,
  useSession,
  type FeatureSpec,
  type TokenUsage,
} from '@moonshot-ai/agent-core';
import {
  createToken,
  inject,
  useExpose,
  useFire,
  type RuntimeEvent,
} from '@moonshot-ai/agent-core/kernel/index';

import { builtinSpawnCatalog, type SpawnModelEntry, type SpawnProfileCatalog } from './catalog';
import { createSpawnTool, type SpawnRegistry } from './tool';

export interface SubagentSpawnedEvent extends RuntimeEvent {
  readonly type: 'subagent.spawned';
  readonly agentId: string;
  readonly parentAgentId: string;
  readonly profile: string;
  readonly model?: string;
  readonly background: boolean;
}

export interface SubagentCompletedEvent extends RuntimeEvent {
  readonly type: 'subagent.completed';
  readonly agentId: string;
  readonly summary: string;
  readonly usage?: TokenUsage;
}

export interface SubagentFailedEvent extends RuntimeEvent {
  readonly type: 'subagent.failed';
  readonly agentId: string;
  readonly error: string;
}

export interface SubagentCancelledEvent extends RuntimeEvent {
  readonly type: 'subagent.cancelled';
  readonly agentId: string;
}

export type SpawnEvent =
  | SubagentSpawnedEvent
  | SubagentCompletedEvent
  | SubagentFailedEvent
  | SubagentCancelledEvent;

export const SpawnRegistryRef = createToken<SpawnRegistry>('spawn.registry');

export interface CreateSpawnProps {
  readonly catalog?: SpawnProfileCatalog;
  readonly models?: readonly SpawnModelEntry[];
  readonly forkEnabled?: () => boolean;
}

export function createSpawn(props: CreateSpawnProps = {}): FeatureSpec<SpawnEvent> {
  const catalog = props.catalog ?? builtinSpawnCatalog;
  const models = props.models ?? [];
  const forkEnabled = props.forkEnabled ?? defaultForkEnabled;
  return createFeature<SpawnEvent>('spawn', {
    session() {
      useExpose(SpawnRegistryRef, new Map());
    },
    agent() {
      useAgentTools(
        createSpawnTool({
          catalog,
          models,
          registry: inject(SpawnRegistryRef),
          session: useSession(),
          agent: useAgent(),
          fire: useFire(),
          forkEnabled,
        }),
      );
    },
  });
}

export const SUBAGENT_FORK_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK';
export const EXPERIMENTAL_MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

function defaultForkEnabled(): boolean {
  return envFlagEnabled(SUBAGENT_FORK_FLAG_ENV) || envFlagEnabled(EXPERIMENTAL_MASTER_ENV);
}

function envFlagEnabled(name: string): boolean {
  const value = process.env[name];
  return value === 'true' || value === '1';
}
