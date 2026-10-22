import { createFeature, useAgent, useSession, type Feature, useAgentTools } from '#/app/index';
import { createFacadeToken, useInject, useExpose, useCleanup } from '#/composition-api/index';
import { createHistoryMessageBuilder, createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { MAIN_AGENT_ID, type Session } from '@moonshot-ai/agent-core/session/index';

import type { OsHost } from '#/todo-features/os/index';
import { ProfileCatalogRef } from '#/todo-features/profiles/ref';

import { subagentCatalogChangeText } from './format';
import { visibleSpawnProfiles, type SpawnModelEntry } from './plan';
import type { ProfileCatalog } from './profile';
import type { SpawnRegistry } from './run';
import { createSpawnTool } from './tool';

export const SpawnRegistryRef = createFacadeToken<SpawnRegistry>('spawn.registry');

export const SUBAGENT_PROFILE_CHANGE_REMIND_KEY = 'subagent-profile-change';

const _EXPERIMENTAL_SUBAGENT_FORK = false;

export interface CreateSpawnProps {
  readonly catalog?: ProfileCatalog;
  readonly models?: readonly SpawnModelEntry[];
  readonly forkEnabled?: () => boolean;
  readonly host?: OsHost;
  readonly workDir?: string;
  readonly EXPERIMENTAL_SUBAGENT_FORK?: boolean;
}

export function createSpawn(props: CreateSpawnProps = {}): Feature<void> {
  const host = props.host;
  const models = props.models ?? [];
  const forkEnabled =
    props.forkEnabled ?? (() => props.EXPERIMENTAL_SUBAGENT_FORK ?? _EXPERIMENTAL_SUBAGENT_FORK);
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
      const profiles = useInject(ProfileCatalogRef).value;
      const catalog = props.catalog ?? profiles;
      if (catalog === undefined) return;
      const registry = useInject(SpawnRegistryRef).value;
      if (registry === undefined) {
        throw new Error('spawn feature session slot is not installed');
      }
      const agent = useAgent();
      useAgentTools(
        createSpawnTool({
          catalog,
          models,
          registry,
          session: useSession(),
          agent,
          forkEnabled,
          process: host?.process,
          workDir,
        }),
      );
      if (props.catalog !== undefined || profiles === undefined || agent.id !== MAIN_AGENT_ID) {
        return;
      }
      const visibleNames = (): readonly string[] =>
        visibleSpawnProfiles(profiles, {
          agentId: agent.id,
          profileName: registry.get(agent.id)?.profileName,
        }).map((profile) => profile.name);
      let listening = false;
      let baseline = visibleNames();
      void profiles.ready.then(() => {
        baseline = visibleNames();
        listening = true;
      });
      useCleanup(
        profiles.onDidChange(() => {
          if (!listening) return;
          const current = visibleSpawnProfiles(profiles, {
            agentId: agent.id,
            profileName: registry.get(agent.id)?.profileName,
          });
          const currentNames = current.map((profile) => profile.name);
          const added = current.filter((profile) => !baseline.includes(profile.name));
          const removed = baseline.filter((name) => !currentNames.includes(name));
          baseline = currentNames;
          if (added.length === 0 && removed.length === 0) return;
          agent.loop.remind(
            createUserEntry(
              createHistoryMessageBuilder()
                .systemReminder(subagentCatalogChangeText(added, removed))
                .userMessage(),
              { source: 'reminder', key: SUBAGENT_PROFILE_CHANGE_REMIND_KEY },
            ),
          );
        }),
      );
    },
  });
}

export const SUBAGENT_FORK_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK';
export const EXPERIMENTAL_MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';
