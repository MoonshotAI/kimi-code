import { join, resolve } from 'node:path';

import {
  createMedia,
  createMemoryMediaSource,
  createMemoryMediaUploadCache,
  MAIN_AGENT_ID,
  type AppHandle,
  type LlmModel,
  type TurnRequest,
} from '@moonshot-ai/agent-core';

import {
  createCompaction,
  createHttp,
  createSummarize,
  createToolSelect,
  features,
  fsSessionSpace,
  isToolSelectEnabled,
  mountHarness,
} from '@moonshot-ai/harness-core';

import { loadKimiCodeDefault } from './kimi-code-config';

export interface ExampleApp {
  readonly app: AppHandle;
  readonly key: string;
  readonly model: LlmModel;
  readonly dataRoot: string;
}

export function mountExample(options?: { http?: boolean }): ExampleApp {
  const { model, requester, credentialProvider, thinking, key } = loadKimiCodeDefault();
  const request: TurnRequest = {
    config: thinking === undefined ? { model } : { model, thinking },
    credentialProvider,
    maxContextTokens: model.maxContextSize,
  };
  const dataRoot = resolve(
    process.env['HARNESS_EXAMPLE_DIR'] ?? join(process.cwd(), '.local/harness-example'),
  );
  const port = Number(process.env['PORT'] ?? 8787);
  const app = mountHarness({
    space: fsSessionSpace(dataRoot),
    requester,
    agent: {
      agentId: MAIN_AGENT_ID,
      request,
    },
    features: [
      ...features,
      createMedia({
        source: createMemoryMediaSource(),
        cache: createMemoryMediaUploadCache(),
      }),
      createToolSelect({
        loadable: () => [],
        enabled: () => isToolSelectEnabled(model.capability),
      }),
      createCompaction({
        summarize: createSummarize({ request, requester }),
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
  return { app, key, model, dataRoot };
}
