import { join, resolve } from 'node:path';

import { createFeature, useSession, type Feature } from '@moonshot-ai/agent-core/app/index';
import { RootRef } from '@moonshot-ai/agent-core/app/units';
import {
  useCollection,
  useInject,
  watch,
  type ComputedRef,
  type ShallowRef,
} from '@moonshot-ai/agent-core/kernel/index';
import type { UnitNode } from '@moonshot-ai/agent-core/kernel/runtime';

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
} from '#/features/config/index';
import { createEdit } from '#/features/edit/index';
import { createExternalHooks } from '#/features/externalHooks/index';
import { createFileHistory } from '#/features/fileHistory/index';
import { createFiles } from '#/features/files/index';
import { InteractionRef, type Interactions } from '#/features/interaction/index';
import { createMcp } from '#/features/mcp/index';
import { createMedia } from '#/features/media/index';
import { createModelsDev } from '#/features/models-dev/index';
import {
  createNodeOsHost,
  createOs,
  detectOpenInApps,
  type OpenInAppId,
  type OsHost,
} from '#/features/os/index';
import { createPermission } from '#/features/permission/index';
import {
  CatalogModels,
  matchCatalogBinding,
  type CatalogModelBinding,
} from '#/features/provider-catalog/index';
import { createProfiles } from '#/features/profiles/index';
import { createSessionExport } from '#/features/sessionExport/index';
import { createSessionIndex } from '#/features/sessionIndex/index';
import { createSessionInit } from '#/features/sessionInit/index';
import { createShellCommand } from '#/features/shellCommand/index';
import { createSkill } from '#/features/skill/index';
import { createSpawn } from '#/features/spawn/index';
import { createToolSelect, isToolSelectEnabled } from '#/features/tool-select/index';
import { createWorkspaces } from '#/features/workspaces/index';
import { fsSessionSpace } from '#/host/index';
import { harnessPreset } from '#/preset';
import { createHarness, type Harness } from '#/runtime/index';

import { loadKimiCodeDefault } from './kimi-code-config';

export interface ExampleProbe {
  readonly root: UnitNode;
  config(): ConfigStore | undefined;
  http(): Http | undefined;
  models(): readonly CatalogModelBinding[];
  interactions(sessionId: string): Interactions | undefined;
}

export interface ExampleApp {
  readonly harness: Harness;
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
  const harness = createHarness({ space: fsSessionSpace(dataRoot) });
  const currentBinding = (): CatalogModelBinding | undefined => {
    const alias = probe.config()?.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
    if (typeof alias !== 'string' || alias.length === 0) return undefined;
    return matchCatalogBinding(alias, probe.models());
  };
  harness.app.features.add(probe.feature);
  harness.app.features.add(
    createConfig({
      persist: createTomlConfigPersist(join(home, 'config.toml')),
      env: process.env,
    }),
  );
  for (const feature of harnessPreset) {
    harness.app.features.add(feature);
  }
  harness.app.features.add(createPermission({ fs: osHost.fs }));
  harness.app.features.add(bindExampleDefaultModel(key));
  harness.app.features.add(createProfiles({ workDir, host: osHost, home }));
  harness.app.features.add(createSpawn({ host: osHost }));
  harness.app.features.add(createEdit({ workDir }));
  harness.app.features.add(createShellCommand({ workDir, host: osHost }));
  harness.app.features.add(createOs({ workDir, host: osHost }));
  harness.app.features.add(createFileHistory({ workDir, fs: osHost.fs }));
  harness.app.features.add(createAgentsMdReminder({ workDir, host: osHost }));
  harness.app.features.add(createSkill({ workDir, fs: osHost.fs, home }));
  harness.app.features.add(createWorkspaces({ homeDir: home, host: osHost }));
  harness.app.features.add(createSessionInit({ workDir, host: osHost }));
  harness.app.features.add(createExternalHooks({ workDir, host: osHost }));
  harness.app.features.add(createSessionExport({ version: '0.0.0' }));
  harness.app.features.add(
    createSessionIndex({
      dbPath: join(dataRoot, '..', 'session-index', 'sessions.db'),
      sessionDir: (sessionId) => join(dataRoot, sessionId),
    }),
  );
  harness.app.features.add(createFiles({ dir: join(dataRoot, '..', 'files') }));
  harness.app.features.add(createModelsDev({ userAgent: 'harness-example' }));
  harness.app.features.add(createMedia({ workDir, host: osHost }));
  harness.app.features.add(createMcp({ workDir, home, host: osHost, trusted: true }));
  harness.app.features.add(
    createToolSelect({
      loadable: () => [],
      enabled: () => isToolSelectEnabled(currentBinding()?.model.capability),
    }),
  );
  harness.app.features.add(
    createCompaction({
      budget: {
        maxContextTokens: () => currentBinding()?.model.maxContextSize ?? 262_144,
        triggerRatio: 0.85,
      },
    }),
  );
  if (options?.http !== false) {
    harness.app.features.add(
      createHttp({
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
    harness.app.features.add(createAcp({ streams: acpStdioStreams() }));
  }
  return { harness, key, dataRoot, probe };
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
