import { join } from 'node:path';

import {
  ConfigRef,
  DEFAULT_MODEL_CONFIG_SECTION,
  ProviderCatalogRef,
  createConfig,
  createHarness,
  createMemoryRefStore,
  createMemoryUploadCache,
  createOAuthCredentialProvider,
  createStaticCredentialProvider,
  CatalogModels,
  matchCatalogBinding,
  type AppHandle,
  type CatalogModelBinding,
  type FeatureSpec,
  type LlmCredentialProvider,
} from '@moonshot-ai/agent-core';
import {
  OAuthTokensRef,
  acpStdioStreams,
  createAcp,
  createAcpOsHostRouter,
  createAgentsMdReminder,
  createCompaction,
  createEdit,
  createExternalHooks,
  createKimi,
  createMcp,
  createMedia,
  createModelsDev,
  createNodeOsHost,
  createOs,
  createPermission,
  createProfiles,
  createSessionExport,
  createSessionInit,
  createShellCommand,
  createSkill,
  createSpawn,
  createSummarize,
  createToolSelect,
  features as presetFeatures,
  fsSessionSpace,
  isToolSelectEnabled,
  type Summarize,
} from '@moonshot-ai/harness-core';
import { createPlugin } from '@moonshot-ai/harness-core/features/plugin/index';
import { createTomlConfigPersist, sanitizeWorkDirKey } from '@moonshot-ai/kimi-code-sdk';

export interface RunAcpHarnessOptions {
  readonly homeDir: string;
  readonly agentInfo: { readonly name: string; readonly version: string };
  readonly terminalAuthEnv?: Readonly<Record<string, string>>;
  readonly terminalAuthLegacyCommand?: string;
}

export async function runAcpHarness(options: RunAcpHarnessOptions): Promise<void> {
  const homeDir = options.homeDir;
  const workDir = process.cwd();
  const configPath = join(homeDir, 'config.toml');
  const sessionsRoot = join(homeDir, 'sessions-v3', sanitizeWorkDirKey(workDir));
  const mediaStore = createMemoryRefStore();
  const localHost = createNodeOsHost();
  await localHost.environment.ready;
  const osRouter = createAcpOsHostRouter({ local: localHost });
  let app: AppHandle;
  const features: FeatureSpec[] = [
    ...presetFeatures.map((spec) => {
      if (spec.featureName === 'kimi') return createKimi({ oauth: { home: homeDir } });
      if (spec.featureName === 'permission') return createPermission({ fs: osRouter.host.fs });
      return spec;
    }),
    createConfig({ persist: createTomlConfigPersist(configPath), env: process.env }),
    createProfiles({ workDir, host: osRouter.host, home: homeDir }),
    createSpawn(),
    createEdit({ workDir, host: osRouter.host }),
    createShellCommand({ workDir, host: osRouter.host }),
    createOs({ workDir, host: osRouter.host }),
    createAgentsMdReminder({ workDir, host: osRouter.host, brandHome: homeDir }),
    createSkill({ workDir, fs: osRouter.host.fs, home: homeDir }),
    createSessionInit({ workDir, host: osRouter.host, brandHome: homeDir }),
    createExternalHooks({ workDir, host: osRouter.host }),
    createSessionExport({
      version: options.agentInfo.version,
      sessionDir: (sessionId) => join(sessionsRoot, sessionId),
    }),
    createModelsDev({}),
    createMedia({
      workDir,
      store: mediaStore,
      cache: createMemoryUploadCache(),
      host: osRouter.host,
    }),
    createMcp({
      workDir,
      home: homeDir,
      host: osRouter.host,
      mediaStore,
      trusted: true,
    }),
    createToolSelect({
      loadable: () => [],
      enabled: () => {
        const binding = resolveDefaultBinding(app);
        return binding !== undefined && isToolSelectEnabled(binding.model.capability ?? {});
      },
    }),
    createCompaction({
      summarize: createCatalogSummarize(() => app),
      budget: {
        maxContextTokens: () => resolveDefaultBinding(app)?.model.maxContextSize ?? 262_144,
        triggerRatio: 0.85,
      },
    }),
    createPlugin({ homeDir, host: osRouter.host }),
    createAcp({
      streams: acpStdioStreams(),
      agentInfo: options.agentInfo,
      terminalAuthEnv: options.terminalAuthEnv,
      terminalAuthLegacyCommand: options.terminalAuthLegacyCommand,
      onSessionActive: osRouter.bind,
      onSessionClose: osRouter.unbind,
    }),
  ];
  app = createHarness({ space: fsSessionSpace(sessionsRoot), features });
  try {
    await app.ready();
    await waitForShutdown();
  } finally {
    await app.disposeAsync();
  }
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.stdin.off('end', done);
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.stdin.on('end', done);
    process.on('SIGINT', done);
    process.on('SIGTERM', done);
  });
}

function resolveDefaultBinding(app: AppHandle): CatalogModelBinding | undefined {
  const config = app.resolve(ConfigRef);
  if (config === undefined) return undefined;
  const alias = config.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
  if (typeof alias !== 'string' || alias.length === 0) return undefined;
  return matchCatalogBinding(alias, app.node.fold(CatalogModels));
}

function resolveSummarizeCredential(
  app: AppHandle,
  binding: CatalogModelBinding,
): LlmCredentialProvider | undefined {
  const config = app.resolve(ConfigRef);
  const catalog = app.resolve(ProviderCatalogRef);
  if (config === undefined || catalog === undefined) return undefined;
  const info = catalog.providerInfo(binding.providerId);
  if (info === undefined) return undefined;
  const envKey = info.env?.['apiKey'];
  const apiKey = info.apiKey ?? (envKey === undefined ? undefined : config.env(envKey));
  if (apiKey !== undefined && apiKey.length > 0) {
    return createStaticCredentialProvider(apiKey);
  }
  const ref = info.oauth;
  if (ref === undefined) return undefined;
  const tokens = app.resolve(OAuthTokensRef);
  if (tokens === undefined) return undefined;
  return createOAuthCredentialProvider(async (tokenOptions) => {
    const token = tokens.resolve(ref);
    if (token === undefined) return undefined;
    try {
      return await token.getAccessToken({ force: tokenOptions?.force });
    } catch {
      return undefined;
    }
  });
}

function createCatalogSummarize(getApp: () => AppHandle): Summarize {
  let cachedAlias: string | undefined;
  let cached: Summarize | undefined;
  return async (input) => {
    const app = getApp();
    const binding = resolveDefaultBinding(app);
    const alias = app.resolve(ConfigRef)?.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
    if (binding === undefined || typeof alias !== 'string') {
      throw new Error('Compaction requires a default model; configure one in config.toml first.');
    }
    if (cached === undefined || cachedAlias !== alias) {
      cached = createSummarize({
        model: { spec: binding.model },
        requester: binding.requester,
        endpoint: { credentials: resolveSummarizeCredential(app, binding) },
      });
      cachedAlias = alias;
    }
    return cached(input);
  };
}
