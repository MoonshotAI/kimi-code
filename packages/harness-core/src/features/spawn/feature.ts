import {
  createFeature,
  useAgent,
  useAgentTools,
  useSession,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';
import { createToken, inject, useExpose, useNode } from '@moonshot-ai/agent-core/kernel/index';

import { createNodeOsHost, type OsHost } from '#/features/os/host/index';
import { ProfileCatalogRef, type ProfileCatalog } from '#/features/profiles/index';
import { type SpawnModelEntry } from './plan';
import { type SpawnRegistry } from './run';
import { createSpawnTool } from './tool';

export const SpawnRegistryRef = createToken<SpawnRegistry>('spawn.registry');

export interface CreateSpawnProps {
  readonly catalog?: ProfileCatalog;
  readonly models?: readonly SpawnModelEntry[];
  readonly forkEnabled?: () => boolean;
  readonly host?: OsHost;
  readonly workDir?: string;
}

export function createSpawn(props: CreateSpawnProps = {}): FeatureSpec {
  const host = props.host ?? createNodeOsHost();
  const models = props.models ?? [];
  const forkEnabled = props.forkEnabled ?? defaultForkEnabled;
  const workDir = props.workDir ?? process.cwd();
  return createFeature('spawn', {
    session() {
      useExpose(SpawnRegistryRef, new Map());
    },
    agent() {
      const catalog =
        props.catalog ?? useNode().providerRef(ProfileCatalogRef).value.at(-1)?.value;
      if (catalog === undefined) return;
      useAgentTools(
        createSpawnTool({
          catalog,
          models,
          registry: inject(SpawnRegistryRef),
          session: useSession(),
          agent: useAgent(),
          forkEnabled,
          process: host.process,
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
