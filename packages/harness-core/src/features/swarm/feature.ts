import { z } from 'zod';

import {
  ConfigRef,
  createFacadeToken,
  createFeature,
  MAIN_AGENT_ID,
  useAgent,
  useAgentTools,
  useBeforeToolBatch,
  useConfigSection,
  useInject,
  useSession,
  type ConfigSectionContribution,
  type EnvBindings,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';
import { useExpose } from '@moonshot-ai/agent-core/kernel/index';

import { stripEnvBoundFields } from '#/config-env';
import type { OsHost } from '#/features/os/host/index';
import { ProfileCatalogRef, type ProfileCatalog } from '#/features/profiles/index';
import {
  SpawnRegistryRef,
  type SpawnModelEntry,
  type SpawnRegistry,
} from '#/features/spawn/index';

import { createSwarmGuard } from './guard';
import { createAgentSwarmTool, type SwarmItemRegistry } from './tool';

export const SWARM_CONFIG_SECTION = 'swarm';

export const DEFAULT_SWARM_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const SWARM_TIMEOUT_ENV = 'KIMI_CODE_SWARM_TIMEOUT_MS';

const swarmConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
});

export type SwarmConfig = z.infer<typeof swarmConfigSchema>;

function parseSwarmTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

const swarmEnvBindings: EnvBindings<SwarmConfig> = {
  timeoutMs: { env: SWARM_TIMEOUT_ENV, parse: parseSwarmTimeoutMsEnv },
};

export const swarmConfigSection: ConfigSectionContribution<SwarmConfig> = {
  name: SWARM_CONFIG_SECTION,
  schema: swarmConfigSchema,
  defaultValue: { timeoutMs: DEFAULT_SWARM_TIMEOUT_MS },
  envBindings: swarmEnvBindings,
  stripEnv: stripEnvBoundFields<SwarmConfig>(swarmEnvBindings),
};

export interface CreateSwarmProps {
  readonly catalog?: ProfileCatalog;
  readonly models?: readonly SpawnModelEntry[];
  readonly forkEnabled?: () => boolean;
  readonly host?: OsHost;
  readonly workDir?: string;
}

interface SwarmSessionState {
  readonly items: SwarmItemRegistry;
  readonly registry: SpawnRegistry;
}

const SwarmSessionRef = createFacadeToken<SwarmSessionState>('swarm.session');

export function createSwarm(props: CreateSwarmProps = {}): FeatureSpec {
  const host = props.host;
  const models = props.models ?? [];
  const forkEnabled = props.forkEnabled ?? defaultForkEnabled;
  const workDir = props.workDir ?? process.cwd();
  return createFeature('swarm', {
    app() {
      useConfigSection(swarmConfigSection);
    },
    session() {
      useExpose(SwarmSessionRef, { items: new Map(), registry: new Map() });
    },
    agent() {
      const agent = useAgent();
      const session = useSession();
      const shared = useInject(SwarmSessionRef).value;
      if (shared === undefined) {
        throw new Error('swarm feature session slot is not installed');
      }

      useBeforeToolBatch(createSwarmGuard({ isMain: agent.agentId === MAIN_AGENT_ID }));

      const catalog = props.catalog ?? useInject(ProfileCatalogRef).value;
      if (catalog !== undefined) {
        const config = useInject(ConfigRef);
        const timeoutMs = (): number =>
          config.value?.get<SwarmConfig | undefined>(SWARM_CONFIG_SECTION)
            ?.timeoutMs ?? DEFAULT_SWARM_TIMEOUT_MS;
        const registry = useInject(SpawnRegistryRef).value ?? shared.registry;
        useAgentTools(
          createAgentSwarmTool({
            catalog,
            models,
            registry,
            session,
            agent,
            forkEnabled,
            process: host?.process,
            workDir,
            swarmItems: shared.items,
            timeoutMs,
          }),
        );
      }
    },
  });
}

const SUBAGENT_FORK_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK';
const EXPERIMENTAL_MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

function defaultForkEnabled(): boolean {
  return envFlagEnabled(SUBAGENT_FORK_FLAG_ENV) || envFlagEnabled(EXPERIMENTAL_MASTER_ENV);
}

function envFlagEnabled(name: string): boolean {
  const value = process.env[name];
  return value === 'true' || value === '1';
}
