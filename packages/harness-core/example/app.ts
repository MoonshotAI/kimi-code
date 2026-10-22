import { join, resolve } from 'node:path';

import { createFeature, useSession, type App, type Feature } from '#/app/index';
import { RootRef } from '#/app/units';
import { createDefaultApp } from '#/defaults/index';
import { acpStdioStreams, createAcp } from '#/feature-acp/index';
import { createHttp, HttpRef, type Http } from '#/feature-http/index';
import {
  CatalogModels,
  type CatalogModelBinding,
} from '#/features/provider-catalog/index';
import {
  useCollection,
  useInject,
  watch,
  type ComputedRef,
  type ShallowRef,
} from '#/kernel/index';
import type { UnitNode } from '#/kernel/runtime';
import {
  ConfigRef,
  DEFAULT_MODEL_CONFIG_SECTION,
  type ConfigStore,
} from '#/todo-features/config/index';
import { InteractionRef, type Interactions } from '#/todo-features/interaction/index';
import { detectOpenInApps, type OpenInAppId, type OsHost } from '#/todo-features/os/index';

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
  const port = Number(process.env['PORT'] ?? 8787);
  const probe = createExampleProbe();
  const { app, host } = createDefaultApp({
    home,
    dataRoot,
    userAgent: 'harness-example',
    trusted: true,
  });
  app.features.add(probe.feature);
  app.features.add(bindExampleDefaultModel(key));
  if (options?.http !== false) {
    app.features.add(
      createHttp({
        homeDir: home,
        listen: {
          port: Number.isFinite(port) ? port : 8787,
          host: process.env['HOST'] ?? '127.0.0.1',
        },
        openInApps: cachedOpenInApps(host),
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
