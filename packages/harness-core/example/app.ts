import { join, resolve } from 'node:path';

import {
  createFeature,
  createMedia,
  createMemoryMediaSource,
  createMemoryMediaUploadCache,
  MAIN_AGENT_ID,
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
  createSummarize,
  createToolSelect,
  features,
  fsSessionSpace,
  isToolSelectEnabled,
  provideSession,
  type SessionSpace,
} from '@moonshot-ai/harness-core';

import { loadKimiCodeDefault } from './kimi-code-config';

export interface ExampleApp {
  readonly app: AppHandle;
  readonly space: SessionSpace;
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
  const space = fsSessionSpace(dataRoot);
  const app = mountApp({
    provide(node) {
      provideSession(node, space, { agent: { agentId: MAIN_AGENT_ID } });
    },
    features: [
      ...features,
      bindExampleLlm(config, credentialProvider, requester),
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
  return { app, space, key, model, dataRoot, requester };
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
