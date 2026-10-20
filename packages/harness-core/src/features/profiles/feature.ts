import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
import {
  createFacadeToken,
  useCollection,
  useExpose,
  useReady,
  watch,
} from '@moonshot-ai/agent-core/kernel/index';

import type { OsHost } from '#/features/os/host/index';

import { createBuiltinFinder, getBuiltinDefaultProfile } from './builtin';
import {
  BUILTIN_PROFILE_SOURCE_ID,
  buildCatalogView,
  type CatalogEntry,
  type CatalogView,
  type ProfileCatalog,
} from './catalog/catalog';
import type { AgentProfileBasePrompt } from './definition/from-file';
import { DEFAULT_AGENT_PROFILE_NAME } from './definition/types';
import { ProfileFinders, useProfileFinder, type ProfileFinder } from './discovery/finder';
import {
  createExplicitFinder,
  createExtraFinder,
  createUserFinder,
  createWorkspaceFinder,
} from './discovery/finders';

export interface ProfileCatalogFace extends ProfileCatalog {
  readonly ready: Promise<void>;
  reload(): Promise<void>;
}

export const ProfileCatalogRef = createFacadeToken<ProfileCatalogFace>('profiles');

export interface CreateProfilesProps {
  readonly workDir: string;
  readonly host?: OsHost;
  readonly home?: string;
  readonly finders?: readonly ProfileFinder[];
  readonly extraAgentDirs?: readonly string[];
  readonly explicitAgentFiles?: readonly string[];
  readonly onWarn?: (message: string) => void;
}

export function createProfiles(props: CreateProfilesProps): Feature<void> {
  return createFeature('profiles', {
    app() {
      const warn = (message: string): void => {
        props.onWarn?.(message);
      };
      const host = props.host;
      const homeDir = props.home ?? process.env['KIMI_CODE_HOME'];
      const osHomeDir = props.home ?? homeDir;
      const builtinDefault = getBuiltinDefaultProfile();
      const userFinder =
        host === undefined || homeDir === undefined
          ? undefined
          : createUserFinder({
              fs: host.fs,
              homeDir,
              osHomeDir,
              builtinDefault,
              onWarn: props.onWarn,
            });
      const userBasePrompt: AgentProfileBasePrompt = (context) =>
        (userFinder?.defaultProfile() ?? builtinDefault).renderSystemPrompt(context);

      useProfileFinder(createBuiltinFinder());
      if (userFinder !== undefined) {
        useProfileFinder(userFinder);
      }
      if (host !== undefined) {
        useProfileFinder(
          createWorkspaceFinder({
            fs: host.fs,
            workDir: props.workDir,
            basePrompt: userBasePrompt,
            onWarn: props.onWarn,
          }),
        );
        if (props.extraAgentDirs !== undefined && props.extraAgentDirs.length > 0) {
          useProfileFinder(
            createExtraFinder({
              fs: host.fs,
              dirs: props.extraAgentDirs,
              workDir: props.workDir,
              osHomeDir,
              basePrompt: userBasePrompt,
              onWarn: props.onWarn,
            }),
          );
        }
        if (props.explicitAgentFiles !== undefined && props.explicitAgentFiles.length > 0) {
          useProfileFinder(
            createExplicitFinder({
              fs: host.fs,
              files: props.explicitAgentFiles,
              workDir: props.workDir,
              osHomeDir,
              basePrompt: userBasePrompt,
            }),
          );
        }
      }
      for (const finder of props.finders ?? []) {
        useProfileFinder(finder);
      }
      const finders = useCollection(ProfileFinders);

      let view: CatalogView = buildCatalogView([]);
      let settled = false;
      let resolveReady!: () => void;
      let rejectReady!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });

      const loadOne = async (finder: ProfileFinder): Promise<CatalogEntry | undefined> => {
        try {
          const contribution = await finder.load();
          return {
            sourceId: finder.sourceId,
            priority: finder.priority ?? 0,
            contribution,
          };
        } catch (error) {
          if (finder.fatal === true) throw error;
          warn(
            `agent profile finder "${finder.sourceId}" failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        }
      };

      const loadAll = async (): Promise<void> => {
        const list = finders.value;
        const builtinPhase = list.filter((f) => f.sourceId === BUILTIN_PROFILE_SOURCE_ID);
        const userPhase = list.filter((f) => f.sourceId === 'user');
        const restPhase = list.filter(
          (f) => f.sourceId !== BUILTIN_PROFILE_SOURCE_ID && f.sourceId !== 'user',
        );
        const entries: (CatalogEntry | undefined)[] = [];
        for (const group of [builtinPhase, userPhase, restPhase]) {
          entries.push(...(await Promise.all(group.map(loadOne))));
        }
        view = buildCatalogView(
          entries.filter((entry) => entry !== undefined),
          warn,
        );
      };

      const runLoad = async (): Promise<void> => {
        try {
          await loadAll();
          if (!settled) {
            settled = true;
            resolveReady();
          }
        } catch (error) {
          if (!settled) {
            settled = true;
            rejectReady(error);
          }
          throw error;
        }
      };

      let rebuildChain = runLoad();
      rebuildChain.catch(() => {});
      const queueRebuild = (): Promise<void> => {
        rebuildChain = rebuildChain.catch(() => {}).then(runLoad);
        return rebuildChain;
      };
      watch(finders, () => {
        void queueRebuild();
      });

      useReady(ready);
      useExpose(ProfileCatalogRef, {
        ready,
        list: () => [...view.merged.values()],
        get: (name) => view.merged.get(name),
        getDefault: () => {
          const profile = view.merged.get(DEFAULT_AGENT_PROFILE_NAME);
          if (profile === undefined) {
            throw new Error(
              `Default agent profile "${DEFAULT_AGENT_PROFILE_NAME}" is not registered`,
            );
          }
          return profile;
        },
        inspect: (name) => view.inspections.get(name),
        reload: () => queueRebuild(),
      });
    },
  });
}
