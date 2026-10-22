import { join, resolve } from 'node:path';

import { nodeSessionSpace } from '@moonshot-ai/agent-core/session/backend/node';

import { createApp, createFeature, useSession, type App, type Feature } from '#/app/index';
import { RootRef } from '#/app/units';
import {
  useCollection,
  useInject,
  watch,
  type ComputedRef,
  type ShallowRef,
} from '#/kernel/index';
import type { UnitNode } from '#/kernel/runtime';

import { acpStdioStreams, createAcp } from '#/feature-acp/index';
import { createHttp, HttpRef, type Http } from '#/feature-http/index';
import { createAgentsMdReminder } from '#/features/agentsMdReminder/index';
import { createCompaction } from '#/features/compaction/index';
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
import { InteractionRef, type Interactions } from '#/todo-features/interaction/index';
import { createMcp } from '#/todo-features/mcp/index';
import { createMedia } from '#/todo-features/media/index';
import { createModelsDev } from '#/features/models-dev/index';
import {
  createNodeOsHost,
  createOs,
  detectOpenInApps,
  type OpenInAppId,
  type OsHost,
} from '#/todo-features/os/index';
import { createPermission } from '#/todo-features/permission/index';
import {
  CatalogModels,
  matchCatalogBinding,
  type CatalogModelBinding,
} from '#/features/provider-catalog/index';
import { createProfiles } from '#/todo-features/profiles/index';
import { createSessionExport } from '#/features/sessionExport/index';
import { createSessionIndex } from '#/todo-features/sessionIndex/index';
import { createSessionInit } from '#/features/sessionInit/index';
import { createShellCommand } from '#/todo-features/shellCommand/index';
import { createSkill } from '#/todo-features/skill/index';
import { createSpawn } from '#/todo-features/spawn/index';
import { createToolSelect, isToolSelectEnabled } from '#/todo-features/tool-select/index';
import { createWorkspaces } from '#/todo-features/workspaces/index';
import { harnessPreset } from '#/preset';

import { loadKimiCodeDefault } from './kimi-code-config';

export interface ExampleProbe {
  readonly root: UnitNode;
  config(): ConfigStore | undefined;
  http(): Http | undefined;
  models(): readonly CatalogModelBinding[];
  interactions(sessionId: string): Interactions | undefined;
}

export interface ExampleApp {
  readonly app: App;
  readonly key: string;
  readonly dataRoot: string;
  readonly probe: ExampleProbe;
}

export function mountExample(options?: { http?: boolean; acp?: boolean }): ExampleApp {
  const { home, key } = loadKimiCodeDefault();
  const dataRoot = resolve(
    process.env['HARNESS_EXAMPLE_DIR'] ?? join(process.cwd(), '.local/harness-example'),
  );
  const workDir = process.cwd();
  const osHost = createNodeOsHost();
  const port = Number(process.env['PORT'] ?? 8787);
  const probe = createExampleProbe();
  const app = createApp({ space: nodeSessionSpace(dataRoot) });
  const currentBinding = (): CatalogModelBinding | undefined => {
    const alias = probe.config()?.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
    if (typeof alias !== 'string' || alias.length === 0) return undefined;
    return matchCatalogBinding(alias, probe.models());
  };
  app.features.add(probe.feature);
  app.features.add(
    createConfig({
      persist: createTomlConfigPersist(join(home, 'config.toml')),
      env: process.env,
    }),
  );
  for (const feature of harnessPreset) {
    app.features.add(feature);
  }
  app.features.add(createPermission({ fs: osHost.fs }));
  app.features.add(bindExampleDefaultModel(key));
  app.features.add(createProfiles({ workDir, host: osHost, home }));
  app.features.add(createSpawn({ host: osHost }));
  app.features.add(createEdit({ workDir }));
  app.features.add(createShellCommand({ workDir, host: osHost }));
  app.features.add(createOs({ workDir, host: osHost }));
  app.features.add(createFileHistory({ workDir, fs: osHost.fs }));
  app.features.add(createAgentsMdReminder({ workDir, host: osHost }));
  app.features.add(createSkill({ workDir, fs: osHost.fs, home }));
  app.features.add(createWorkspaces({ homeDir: home, host: osHost }));
  app.features.add(createSessionInit({ workDir, host: osHost }));
  app.features.add(createExternalHooks({ workDir, host: osHost }));
  app.features.add(createSessionExport({ version: '0.0.0' }));
  app.features.add(
    createSessionIndex({
      dbPath: join(dataRoot, '..', 'session-index', 'sessions.db'),
      sessionDir: (sessionId) => join(dataRoot, sessionId),
    }),
  );
  app.features.add(createFiles({ dir: join(dataRoot, '..', 'files') }));
  app.features.add(createModelsDev({ userAgent: 'harness-example' }));
  app.features.add(createMedia({ workDir, host: osHost }));
  app.features.add(createMcp({ workDir, home, host: osHost, trusted: true }));
  app.features.add(
    createToolSelect({
      loadable: () => [],
      enabled: () => isToolSelectEnabled(currentBinding()?.model.capability),
    }),
  );
  app.features.add(
    createCompaction({
      budget: {
        maxContextTokens: () => currentBinding()?.model.maxContextSize ?? 262_144,
        triggerRatio: 0.85,
      },
    }),
  );
  if (options?.http !== false) {
    app.features.add(
      createHttp({
        homeDir: home,
        listen: {
          port: Number.isFinite(port) ? port : 8787,
          host: process.env['HOST'] ?? '127.0.0.1',
        },
        openInApps: cachedOpenInApps(osHost),
        corsOrigins: (process.env['KIMI_CODE_CORS_ORIGINS'] ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      }),
    );
  }
  if (options?.acp === true) {
    app.features.add(createAcp({ streams: acpStdioStreams() }));
  }
  return { app, key, dataRoot, probe };
}

function createExampleProbe(): ExampleProbe & { readonly feature: Feature<void> } {
  let root: UnitNode | undefined;
  let config: Readonly<ShallowRef<ConfigStore | undefined>> | undefined;
  let http: Readonly<ShallowRef<Http | undefined>> | undefined;
  let models: ComputedRef<readonly CatalogModelBinding[]> | undefined;
  const interactions = new Map<string, Readonly<ShallowRef<Interactions | undefined>>>();
  const feature = createFeature('example-probe', {
    app() {
      root = useInject(RootRef);
      config = useInject(ConfigRef);
      http = useInject(HttpRef);
      models = useCollection(CatalogModels);
    },
    session() {
      const session = useSession();
      interactions.set(session.id, useInject(InteractionRef));
    },
  });
  return {
    feature,
    get root() {
      if (root === undefined) throw new Error('example probe is not mounted');
      return root;
    },
    config: () => config?.value,
    http: () => http?.value,
    models: () => models?.value ?? [],
    interactions: (sessionId) => interactions.get(sessionId)?.value,
  };
}

function bindExampleDefaultModel(key: string): Feature<void> {
  return createFeature('example-llm', {
    app() {
      const config = useInject(ConfigRef);
      watch(
        config,
        (store) => {
          if (store === undefined) return;
          void store.set(DEFAULT_MODEL_CONFIG_SECTION, key, 'memory').catch(() => {});
        },
        { immediate: true },
      );
    },
  });
}

function cachedOpenInApps(host: OsHost): () => Promise<readonly OpenInAppId[]> {
  let cached: Promise<readonly OpenInAppId[]> | undefined;
  return () => {
    cached ??= detectOpenInApps(host);
    return cached;
  };
}
