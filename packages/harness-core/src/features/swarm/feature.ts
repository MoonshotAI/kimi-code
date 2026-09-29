import { z } from 'zod';

import {
  ConfigRef,
  createFeature,
  MAIN_AGENT_ID,
  useAgent,
  useAgentStore,
  useAgentTools,
  useBeforeStep,
  useBeforeToolBatch,
  useConfigSection,
  useSession,
  type ConfigSectionContribution,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';
import {
  createToken,
  inject,
  useExpose,
  useNode,
  type ShallowRef,
} from '@moonshot-ai/agent-core/kernel/index';

import { createNodeOsHost, type OsHost } from '#/features/os/host/index';
import { ProfileCatalogRef, type ProfileCatalog } from '#/features/profiles/index';
import {
  SpawnRegistryRef,
  type SpawnModelEntry,
  type SpawnRegistry,
} from '#/features/spawn/index';

import { createSwarmGuard } from './guard';
import { createSwarmInjection } from './injection';
import {
  SWARM_MODE_ENTER,
  SWARM_MODE_EXIT,
  swarmModeProjection,
  type SwarmModeState,
  type SwarmModeTrigger,
} from './ops';
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

export const swarmConfigSection: ConfigSectionContribution<SwarmConfig> = {
  name: SWARM_CONFIG_SECTION,
  schema: swarmConfigSchema,
  defaultValue: { timeoutMs: DEFAULT_SWARM_TIMEOUT_MS },
  envBindings: {
    timeoutMs: { env: SWARM_TIMEOUT_ENV, parse: parseSwarmTimeoutMsEnv },
  },
  stripEnv: (value) => {
    const out = { ...value };
    delete out.timeoutMs;
    return out;
  },
};

export interface SwarmFace {
  readonly state: ShallowRef<SwarmModeState>;
  isActive(): boolean;
  enter(trigger: SwarmModeTrigger): Promise<void>;
  exit(): Promise<void>;
}

export const SwarmRef = createToken<SwarmFace>('swarm');

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

const SwarmSessionRef = createToken<SwarmSessionState>('swarm.session');

export function createSwarm(props: CreateSwarmProps = {}): FeatureSpec {
  const host = props.host ?? createNodeOsHost();
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
      const node = useNode();
      const agent = useAgent();
      const session = useSession();
      const store = useAgentStore();
      const state = store.fold(swarmModeProjection);
      const shared = inject(SwarmSessionRef);

      const isActive = (): boolean => state.value.trigger !== null;
      const enter = async (trigger: SwarmModeTrigger): Promise<void> => {
        if (state.value.trigger !== null) return;
        await store.dispatch({ type: SWARM_MODE_ENTER, trigger });
      };
      const exit = async (): Promise<void> => {
        if (state.value.trigger === null) return;
        await store.dispatch({ type: SWARM_MODE_EXIT });
      };

      agent.on('turn.done', () => {
        const trigger = state.value.trigger;
        if (trigger === 'task' || trigger === 'tool') {
          void exit().catch(() => {});
        }
      });

      useBeforeStep(
        createSwarmInjection({ agent, state, history: store.getState().history }),
      );
      useBeforeToolBatch(createSwarmGuard({ isMain: agent.agentId === MAIN_AGENT_ID }));

      const catalog =
        props.catalog ?? node.providerRef(ProfileCatalogRef).value.at(-1)?.value;
      if (catalog !== undefined) {
        const configEntries = node.providerRef(ConfigRef);
        const timeoutMs = (): number =>
          configEntries.value.at(-1)?.value.get<SwarmConfig | undefined>(SWARM_CONFIG_SECTION)
            ?.timeoutMs ?? DEFAULT_SWARM_TIMEOUT_MS;
        const registry =
          node.providerRef(SpawnRegistryRef).value.at(-1)?.value ?? shared.registry;
        useAgentTools(
          createAgentSwarmTool({
            catalog,
            models,
            registry,
            session,
            agent,
            forkEnabled,
            process: host.process,
            workDir,
            swarmItems: shared.items,
            timeoutMs,
            enterSwarmMode: () => enter('tool'),
          }),
        );
      }

      useExpose(SwarmRef, { state, isActive, enter, exit });
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
