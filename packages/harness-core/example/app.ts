import { join, resolve } from 'node:path';

import {
  createFeature,
  createMedia,
  createMemoryMediaSource,
  createMemoryMediaUploadCache,
  mountApp,
  useAgent,
  type AppHandle,
  type LlmCredentialProvider,
  type LlmModel,
  type LlmRequestConfig,
  type LlmRequester,
} from '@moonshot-ai/agent-core';
import {
  createCompaction,
  createHttp,
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

export function mountExample(options?: { http?: boolean }): ExampleApp {
  const { model, requester, credentialProvider, thinking, key } = loadKimiCodeDefault();
  const config: LlmRequestConfig = thinking === undefined ? { model } : { model, thinking };
  const dataRoot = resolve(
    process.env['HARNESS_EXAMPLE_DIR'] ?? join(process.cwd(), '.local/harness-example'),
  );
  const port = Number(process.env['PORT'] ?? 8787);
  const app = mountApp({
    space: fsSessionSpace(dataRoot),
    features: [
      ...features,
      bindExampleLlm(config, credentialProvider, requester),
      createSpawn(),
      createMedia({
        source: createMemoryMediaSource(),
        cache: createMemoryMediaUploadCache(),
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
