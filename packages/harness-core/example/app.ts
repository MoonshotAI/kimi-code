import { watch as fsWatch } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import {
  createConfig,
  createFeature,
  createMemoryRefStore,
  createMemoryUploadCache,
  createHarness,
  useAgent,
  type AgentLlmRequester,
  type AppHandle,
  type LlmEndpoint,
  type LlmModelSpec,
  type LlmRequestModel,
} from '@moonshot-ai/agent-core';
import {
  acpStdioStreams,
  createAcp,
  createAgentsMdReminder,
  createCompaction,
  createEdit,
  createExternalHooks,
  createFileHistory,
  createFiles,
  createHttp,
  createMcp,
  createMedia,
  createModelsDev,
  createNodeOsHost,
  createOs,
  createPermission,
  createProfiles,
  createShellCommand,
  createSessionExport,
  createSessionInit,
  createSessionIndex,
  createSkill,
  createSpawn,
  createSummarize,
  createToolSelect,
  createWorkspaces,
  detectOpenInApps,
  features,
  fsSessionSpace,
  isToolSelectEnabled,
  type OpenInAppId,
  type OsHost,
} from '@moonshot-ai/harness-core';

import { loadKimiCodeDefault } from './kimi-code-config';

export interface ExampleApp {
  readonly app: AppHandle;
  readonly key: string;
  readonly model: LlmModelSpec;
  readonly dataRoot: string;
  readonly requester: AgentLlmRequester;
}

export function mountExample(options?: { http?: boolean; acp?: boolean }): ExampleApp {
  const { model, requester, endpoint, thinking, key } = loadKimiCodeDefault();
  const config: LlmRequestModel = thinking === undefined ? { spec: model } : { spec: model, thinking };
  const dataRoot = resolve(
    process.env['HARNESS_EXAMPLE_DIR'] ?? join(process.cwd(), '.local/harness-example'),
  );
  const home = process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
  const port = Number(process.env['PORT'] ?? 8787);
  const mediaStore = createMemoryRefStore();
  const osHost = createNodeOsHost();
  const app = createHarness({
    space: fsSessionSpace(dataRoot),
    features: [
      createConfig({
        persist: fsConfigPersist(join(home, 'config.toml')),
        env: process.env,
      }),
      ...features.map((spec) =>
        spec.featureName === 'permission' ? createPermission({ fs: osHost.fs }) : spec,
      ),
      bindExampleLlm(config, endpoint, requester),
      createProfiles({ workDir: process.cwd(), host: osHost, home }),
      createSpawn({ host: osHost }),
      createEdit({ workDir: process.cwd(), host: osHost }),
      createShellCommand({ workDir: process.cwd(), host: osHost }),
      createOs({ workDir: process.cwd(), host: osHost }),
      createFileHistory({ workDir: process.cwd(), fs: osHost.fs }),
      createAgentsMdReminder({ workDir: process.cwd(), host: osHost }),
      createSkill({ workDir: process.cwd(), fs: osHost.fs, home }),
      createWorkspaces({ homeDir: home, host: osHost }),
      createSessionInit({ workDir: process.cwd(), host: createNodeOsHost() }),
      createExternalHooks({ workDir: process.cwd(), host: createNodeOsHost() }),
      createSessionExport({
        version: '0.0.0',
        sessionDir: (sessionId) => join(dataRoot, sessionId),
      }),
      createSessionIndex({
        dbPath: join(dataRoot, '..', 'session-index', 'sessions.db'),
        sessionDir: (sessionId) => join(dataRoot, sessionId),
      }),
      createFiles({ dir: join(dataRoot, '..', 'files') }),
      createModelsDev({ userAgent: 'harness-example' }),
      createMedia({
        workDir: process.cwd(),
        store: mediaStore,
        cache: createMemoryUploadCache(),
        host: createNodeOsHost(),
      }),
      createMcp({
        workDir: process.cwd(),
        home,
        host: createNodeOsHost(),
        mediaStore,
        trusted: true,
      }),
      createToolSelect({
        loadable: () => [],
        enabled: () => isToolSelectEnabled(model.capability),
      }),
      createCompaction({
        summarize: createSummarize({ model: config, requester, endpoint }),
        budget: {
          maxContextTokens: () => model.maxContextSize ?? 262_144,
          triggerRatio: 0.85,
        },
      }),
      ...(options?.http === false
        ? []
        : [
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
          ]),
      ...(options?.acp === true ? [createAcp({ streams: acpStdioStreams() })] : []),
    ],
  });
  return { app, key, model, dataRoot, requester };
}

function cachedOpenInApps(host: OsHost): () => Promise<readonly OpenInAppId[]> {
  let cached: Promise<readonly OpenInAppId[]> | undefined;
  return () => {
    cached ??= detectOpenInApps(host);
    return cached;
  };
}

function fsConfigPersist(path: string) {
  return {
    load: async () => {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    save: async (text: string) => {
      const tmp = `${path}.tmp-${String(process.pid)}`;
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, path);
    },
    watch: (onChange: () => void) => {
      const watcher = fsWatch(dirname(path), (_event, name) => {
        if (name === basename(path)) {
          onChange();
        }
      });
      return () => {
        watcher.close();
      };
    },
  };
}

function bindExampleLlm(
  config: LlmRequestModel,
  endpoint: LlmEndpoint,
  requester: AgentLlmRequester,
) {
  return createFeature('example-llm', {
    agent() {
      const agent = useAgent();
      agent.setModel(config);
      agent.setEndpoint(endpoint);
      agent.setRequester(requester);
    },
  });
}
