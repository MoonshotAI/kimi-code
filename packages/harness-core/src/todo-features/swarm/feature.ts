import { z } from 'zod';

import { createFeature, useAgent, useSession, useToolBatchStarting, type Feature, useAgentTools, useClock } from '#/app/index';
import { createFacadeToken, useExpose, useInject } from '#/composition-api/index';
import { MAIN_AGENT_ID, type Session } from '@moonshot-ai/agent-core/session/index';

import {
  ConfigRef,
  useConfigSection,
  type ConfigSectionContribution,
  type EnvBindings,
} from '#/todo-features/config/index';
import { stripEnvBoundFields } from '#/todo-features/os/configSections';
import type { OsHost } from '#/todo-features/os/index';
import { ProfileCatalogRef } from '#/todo-features/profiles/ref';
import {
  SpawnRegistryRef,
  type ProfileCatalog,
  type SpawnModelEntry,
  type SpawnRegistry,
} from '#/todo-features/spawn/index';

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

const _EXPERIMENTAL_SUBAGENT_FORK = false;
const _AGENT_SWARM_MAX_CONCURRENCY: number | undefined = undefined;

export interface CreateSwarmProps {
  readonly catalog?: ProfileCatalog;
  readonly models?: readonly SpawnModelEntry[];
  readonly forkEnabled?: () => boolean;
  readonly host?: OsHost;
  readonly workDir?: string;
  readonly EXPERIMENTAL_SUBAGENT_FORK?: boolean;
  readonly AGENT_SWARM_MAX_CONCURRENCY?: number;
}

interface SwarmSessionState {
  readonly items: SwarmItemRegistry;
  readonly registry: SpawnRegistry;
}

const SwarmSessionRef = createFacadeToken<SwarmSessionState>('swarm.session');

export function createSwarm(props: CreateSwarmProps = {}): Feature<void> {
  const host = props.host;
  const models = props.models ?? [];
  const forkEnabled =
    props.forkEnabled ?? (() => props.EXPERIMENTAL_SUBAGENT_FORK ?? _EXPERIMENTAL_SUBAGENT_FORK);
  const maxConcurrency = props.AGENT_SWARM_MAX_CONCURRENCY ?? _AGENT_SWARM_MAX_CONCURRENCY;
  const workDir = props.workDir ?? process.cwd();
  const states = new WeakMap<Session, SwarmSessionState>();
  return createFeature('swarm', {
    app() {
      useConfigSection(swarmConfigSection);
    },
    session() {
      const session = useSession();
      let state = states.get(session);
      if (state === undefined) {
        state = { items: new Map(), registry: new Map() };
        states.set(session, state);
      }
      useExpose(SwarmSessionRef, state);
    },
    agent() {
      const agent = useAgent();
      const session = useSession();
      const clock = useClock();
      const shared = useInject(SwarmSessionRef).value;
      if (shared === undefined) {
        throw new Error('swarm feature session slot is not installed');
      }

      useToolBatchStarting(createSwarmGuard({ isMain: agent.id === MAIN_AGENT_ID }));

      const catalog = props.catalog ?? useInject(ProfileCatalogRef).value;
      if (catalog === undefined) return;
      const config = useInject(ConfigRef);
      const timeoutMs = (): number =>
        config.value?.get<SwarmConfig | undefined>(SWARM_CONFIG_SECTION)?.timeoutMs ??
        DEFAULT_SWARM_TIMEOUT_MS;
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
          clock,
          maxConcurrency,
        }),
      );
    },
  });
}
