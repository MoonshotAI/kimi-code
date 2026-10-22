import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { nodeSessionSpace } from '@moonshot-ai/agent-core/session/backend/node';
import type { SessionSpace } from '@moonshot-ai/agent-core/session/index';

import { createApp, createFeature, type App, type Feature } from '#/app/index';
import {
  useCollection,
  useInject,
  type ComputedRef,
  type ShallowRef,
} from '#/kernel/index';
import { createAgentsMdReminder } from '#/features/agentsMdReminder/index';
import { createCapabilities } from '#/features/capabilities/index';
import { createCompaction } from '#/features/compaction/index';
import { createModelsDev } from '#/features/models-dev/index';
import {
  CatalogModels,
  matchCatalogBinding,
  type CatalogModelBinding,
} from '#/features/provider-catalog/index';
import { createPtc } from '#/features/ptc/index';
import { createSessionExport } from '#/features/sessionExport/index';
import { createSessionInit } from '#/features/sessionInit/index';
import { harnessPreset } from '#/preset';
import {
  ConfigRef,
  createConfig,
  createTomlConfigPersist,
  DEFAULT_MODEL_CONFIG_SECTION,
  type ConfigStore,
} from '#/todo-features/config/index';
import { createEdit } from '#/todo-features/edit/index';
import { createExternalHooks } from '#/todo-features/externalHooks/index';
import { createFileHistory } from '#/todo-features/fileHistory/index';
import { createFiles } from '#/todo-features/files/index';
import { createMcp } from '#/todo-features/mcp/index';
import { createMedia } from '#/todo-features/media/index';
import { createNotify } from '#/todo-features/notify/index';
import { createNodeOsHost, createOs, type OsHost } from '#/todo-features/os/index';
import { createPermission } from '#/todo-features/permission/index';
import { createPlugin } from '#/todo-features/plugin/index';
import { createProfiles } from '#/todo-features/profiles/index';
import { createSessionIndex } from '#/todo-features/sessionIndex/index';
import { createShellCommand } from '#/todo-features/shellCommand/index';
import { createSkill } from '#/todo-features/skill/index';
import { createSpawn } from '#/todo-features/spawn/index';
import { createTelemetry } from '#/todo-features/telemetry/index';
import { createToolSelect, isToolSelectEnabled } from '#/todo-features/tool-select/index';
import { createTower } from '#/todo-features/tower/index';
import { createWorkspaces } from '#/todo-features/workspaces/index';

export interface CreateDefaultAppOptions {
  readonly home?: string;
  readonly dataRoot?: string;
  readonly workDir?: string;
  readonly host?: OsHost;
  readonly env?: NodeJS.ProcessEnv;
  readonly version?: string;
  readonly userAgent?: string;
  readonly trusted?: boolean;
  readonly space?: SessionSpace;
}

export interface DefaultApp {
  readonly app: App;
  readonly home: string;
  readonly dataRoot: string;
  readonly workDir: string;
  readonly host: OsHost;
}

export function createDefaultApp(options: CreateDefaultAppOptions = {}): DefaultApp {
  const home = options.home ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
  const workDir = options.workDir ?? process.cwd();
  const host = options.host ?? createNodeOsHost();
  const env = options.env ?? process.env;
  const dataRoot = resolve(options.dataRoot ?? join(home, 'sessions-v3', workDirKeyOf(workDir)));
  const space = options.space ?? nodeSessionSpace(dataRoot);
  const binding = bindDefaultModel();
  const app = createApp({ space });
  app.features.add(binding.feature);
  app.features.add(
    createConfig({
      persist: createTomlConfigPersist(join(home, 'config.toml')),
      env,
    }),
  );
  app.features.add(createTelemetry());
  for (const feature of harnessPreset) {
    app.features.add(feature);
  }
  app.features.add(createPermission({ workDir, homeDir: home, fs: host.fs }));
  app.features.add(createProfiles({ workDir, host, home }));
  app.features.add(createSpawn({ host }));
  app.features.add(createEdit({ workDir }));
  app.features.add(createShellCommand({ workDir, host }));
  app.features.add(createOs({ workDir, host }));
  app.features.add(createFileHistory({ workDir, fs: host.fs }));
  app.features.add(createAgentsMdReminder({ workDir, host }));
  app.features.add(createSkill({ workDir, fs: host.fs, home }));
  app.features.add(createPlugin({ homeDir: home, host }));
  app.features.add(createWorkspaces({ homeDir: home, host }));
  app.features.add(createSessionInit({ workDir, host }));
  app.features.add(createExternalHooks({ workDir, host }));
  app.features.add(createSessionExport({ version: options.version ?? '0.0.0' }));
  app.features.add(
    createSessionIndex({
      dbPath: join(dataRoot, '..', 'session-index', 'sessions.db'),
      sessionDir: (sessionId) => join(dataRoot, sessionId),
    }),
  );
  app.features.add(createFiles({ dir: join(dataRoot, '..', 'files') }));
  app.features.add(createModelsDev({ userAgent: options.userAgent }));
  app.features.add(createMedia({ workDir, host }));
  app.features.add(
    createMcp({
      workDir,
      home,
      host,
      trusted: options.trusted ?? false,
    }),
  );
  app.features.add(
    createToolSelect({
      loadable: () => [],
      enabled: () => isToolSelectEnabled(binding.current()?.model.capability),
    }),
  );
  app.features.add(
    createCompaction({
      budget: {
        maxContextTokens: () => binding.current()?.model.maxContextSize ?? 262_144,
        triggerRatio: 0.85,
      },
    }),
  );
  app.features.add(createCapabilities({ homeDir: home, host }));
  app.features.add(createNotify());
  app.features.add(createTower({ workDir, host }));
  app.features.add(createPtc({ dir: workDir }));
  return { app, home, dataRoot, workDir, host };
}

function bindDefaultModel(): {
  readonly feature: Feature<void>;
  readonly current: () => CatalogModelBinding | undefined;
} {
  let config: Readonly<ShallowRef<ConfigStore | undefined>> | undefined;
  let models: ComputedRef<readonly CatalogModelBinding[]> | undefined;
  const feature = createFeature('defaults-model-binding', {
    app() {
      config = useInject(ConfigRef);
      models = useCollection(CatalogModels);
    },
  });
  return {
    feature,
    current: () => {
      const alias = config?.value?.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
      if (typeof alias !== 'string' || alias.length === 0) return undefined;
      return matchCatalogBinding(alias, models?.value ?? []);
    },
  };
}

function workDirKeyOf(workDir: string): string {
  const key = resolve(workDir)
    .replaceAll(/[^a-zA-Z0-9]+/g, '-')
    .replaceAll(/(?:^-)|(?:-$)/g, '');
  return key === '' ? 'root' : key;
}
