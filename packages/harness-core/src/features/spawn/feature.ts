import {
  createFeature,
  useAgent,
  useApp,
  useSession,
  type Feature,
} from '@moonshot-ai/agent-core/app/index';
import { createFacadeToken, useInject, useExpose } from '@moonshot-ai/agent-core/kernel/index';
import type { Session } from '@moonshot-ai/agent-core/session/index';

import type { OsHost } from '#/features/os/index';
import { useAgentRuntime, useAgentTools } from '#/runtime/index';

import type { SpawnModelEntry } from './plan';
import type { ProfileCatalog } from './profile';
import type { SpawnRegistry } from './run';
import { createSpawnTool } from './tool';

export const SpawnRegistryRef = createFacadeToken<SpawnRegistry>('spawn.registry');

export interface CreateSpawnProps {
  readonly catalog?: ProfileCatalog;
  readonly models?: readonly SpawnModelEntry[];
  readonly forkEnabled?: () => boolean;
  readonly host?: OsHost;
  readonly workDir?: string;
}

export function createSpawn(props: CreateSpawnProps = {}): Feature<void> {
  const host = props.host;
  const models = props.models ?? [];
  const forkEnabled = props.forkEnabled ?? defaultForkEnabled;
  const workDir = props.workDir ?? process.cwd();
  const registries = new WeakMap<Session, SpawnRegistry>();
  return createFeature('spawn', {
    session() {
      const session = useSession();
      let registry = registries.get(session);
      if (registry === undefined) {
        registry = new Map();
        registries.set(session, registry);
      }
      useExpose(SpawnRegistryRef, registry);
    },
    agent() {
      const catalog = props.catalog;
      if (catalog === undefined) return;
      const registry = useInject(SpawnRegistryRef).value;
      if (registry === undefined) {
        throw new Error('spawn feature session slot is not installed');
      }
      useAgentTools(
        createSpawnTool({
          catalog,
          models,
          registry,
          session: useSession(),
          agent: useAgent(),
          app: useApp(),
          runtime: useAgentRuntime(),
          forkEnabled,
          process: host?.process,
          workDir,
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
