import { join, resolve } from 'node:path';

import {
  createFeature,
  createMemoryMediaStore,
  createMemoryMediaUploadCache,
  createHarness,
  useAgent,
  type AppHandle,
  type LlmCredentialProvider,
  type LlmModel,
  type LlmRequestConfig,
  type LlmRequester,
} from '@moonshot-ai/agent-core';
import {
  acpStdioStreams,
  createAcp,
  createAgentsMdReminder,
  createCompaction,
  createEdit,
  createExternalHooks,
  createHttp,
  createMcp,
  createMedia,
  createModelsDev,
  createNodeOsHost,
  createOs,
  createProfiles,
  createShellCommand,
  createSessionExport,
  createSessionInit,
  createSkill,
  createSpawn,
  createSummarize,
  createToolSelect,
  features,
  fsSessionSpace,
  isToolSelectEnabled,
} from '@moonshot-ai/harness-core';

import { loadKimiCodeDefault } from './kimi-code-config';

export interface ExampleApp {
  readonly app: AppHandle;
  readonly key: string;
  readonly model: LlmModel;
  readonly dataRoot: string;
  readonly requester: LlmRequester;
}

export function mountExample(options?: { http?: boolean; acp?: boolean }): ExampleApp {
  const { model, requester, credentialProvider, thinking, key } = loadKimiCodeDefault();
  const config: LlmRequestConfig = thinking === undefined ? { model } : { model, thinking };
  const dataRoot = resolve(
    process.env['HARNESS_EXAMPLE_DIR'] ?? join(process.cwd(), '.local/harness-example'),
  );
  const port = Number(process.env['PORT'] ?? 8787);
  const mediaStore = createMemoryMediaStore();
  const osHost = createNodeOsHost();
  const app = createHarness({
    space: fsSessionSpace(dataRoot),
    features: [
      ...features,
      bindExampleLlm(config, credentialProvider, requester),
      createProfiles({ workDir: process.cwd() }),
      createSpawn(),
      createEdit({ workDir: process.cwd() }),
      createShellCommand({ workDir: process.cwd() }),
      createOs({ workDir: process.cwd(), host: osHost }),
      createAgentsMdReminder({ workDir: process.cwd(), host: osHost }),
      createSkill({ workDir: process.cwd(), host: createNodeOsHost() }),
      createSessionInit({ workDir: process.cwd(), host: createNodeOsHost() }),
      createExternalHooks({ workDir: process.cwd(), host: createNodeOsHost() }),
      createSessionExport({
        version: '0.0.0',
        sessionDir: (sessionId) => join(dataRoot, sessionId),
      }),
      createModelsDev({ userAgent: 'harness-example' }),
      createMedia({
        workDir: process.cwd(),
        store: mediaStore,
        cache: createMemoryMediaUploadCache(),
        host: createNodeOsHost(),
      }),
      createMcp({
        workDir: process.cwd(),
        host: createNodeOsHost(),
        mediaStore,
        trusted: true,
      }),
      createToolSelect({
        loadable: () => [],
        enabled: () => isToolSelectEnabled(model.capability),
      }),
      createCompaction({
        summarize: createSummarize({ config, requester, credentialProvider }),
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
            }),
          ]),
      ...(options?.acp === true ? [createAcp({ streams: acpStdioStreams() })] : []),
    ],
  });
  return { app, key, model, dataRoot, requester };
}

function bindExampleLlm(
  config: LlmRequestConfig,
  credentialProvider: LlmCredentialProvider,
  requester: LlmRequester,
) {
  return createFeature('example-llm', {
    agent() {
      const agent = useAgent();
      agent.setConfig(config);
      agent.setCredentialProvider(credentialProvider);
      agent.setRequester(requester);
    },
  });
}
