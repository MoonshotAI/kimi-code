import { describe, expect, it } from 'vitest';

import type { KimiHarness, ModelAlias } from '@moonshot-ai/kimi-code-sdk';

import { listModelsFromHarness } from '../src/model-catalog';

function harnessWithModels(models: unknown): KimiHarness {
  return {
    getConfig: async () => ({ models }),
  } as unknown as KimiHarness;
}

describe('listModelsFromHarness', () => {
  it('projects configured model aliases into ACP model entries', async () => {
    const models: Record<string, ModelAlias> = {
      coder: {
        model: 'kimi-code',
        displayName: 'Kimi Code',
        capabilities: ['thinking'],
      } as ModelAlias,
    };

    await expect(listModelsFromHarness(harnessWithModels(models))).resolves.toEqual([
      {
        id: 'coder',
        name: 'Kimi Code',
        thinkingSupported: true,
        alwaysThinking: false,
      },
    ]);
  });

  it('returns an empty catalog for malformed models values', async () => {
    await expect(listModelsFromHarness(harnessWithModels(null))).resolves.toEqual([]);
    await expect(listModelsFromHarness(harnessWithModels('bad-models'))).resolves.toEqual([]);
    await expect(listModelsFromHarness(harnessWithModels(['coder']))).resolves.toEqual([]);
  });
});
