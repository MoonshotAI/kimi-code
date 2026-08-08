/**
 * Scenario: pruning the bundled models.dev catalog.
 * Responsibilities: preserve the model semantics observed by Kimi Code's catalog consumer.
 * Wiring: the real pruning function and public catalog consumer with a pinned raw catalog fixture.
 * Fixture: models.dev/api.json fetched 2026-07-25, reduced to three real model entries.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/scripts/update-catalog.test.ts
 */

import { readFileSync } from 'node:fs';

import { catalogProviderModels, type Catalog } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { stripCatalog } from '../../scripts/update-catalog.mjs';

const fixtureUrl = new URL('./fixtures/models-dev-api-2026-07-25.json', import.meta.url);

function loadFixture(): Catalog {
  return JSON.parse(readFileSync(fixtureUrl, 'utf8')) as Catalog;
}

function consumeCatalog(catalog: Catalog): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(catalog).map(([id, provider]) => [id, catalogProviderModels(provider)]),
  );
}

describe('catalog snapshot pruning', () => {
  it('preserves consumer output when a release snapshot is pruned', () => {
    const rawCatalog = loadFixture();

    const strippedCatalog = stripCatalog(rawCatalog) as Catalog;

    expect(consumeCatalog(strippedCatalog)).toEqual(consumeCatalog(rawCatalog));
  });

  it.each([
    {
      field: 'reasoning_options',
      providerId: 'anyapi',
      modelId: 'anthropic/claude-sonnet-4-6',
    },
    { field: 'status', providerId: 'anyapi', modelId: 'mistralai/devstral-2512' },
    { field: 'provider', providerId: 'opencode', modelId: 'claude-sonnet-4-6' },
  ] as const)('exercises $field through observable consumer output', ({ field, providerId, modelId }) => {
    const rawCatalog = loadFixture();
    const withoutField = structuredClone(rawCatalog) as unknown as Record<
      string,
      { models: Record<string, Record<string, unknown>> }
    >;
    delete withoutField[providerId]!.models[modelId]![field];

    expect(consumeCatalog(withoutField as unknown as Catalog)).not.toEqual(
      consumeCatalog(rawCatalog),
    );
  });
});
