import { fileURLToPath } from 'node:url';

import { expectContractGolden } from '@moonshot-ai/testkit/contract';
import { expect, test as base } from 'vitest';

import { scenarioFixtures, type ScenarioFixtures } from './support/scenario';

const test = base.extend<ScenarioFixtures>(scenarioFixtures({ serverVersion: '0.0.0-fixture' }));

const schemaFile = (name: string): string => fileURLToPath(new URL(`../../packages/kap-server/schema/${name}`, import.meta.url));

test('publishes the reviewed REST and WebSocket field contracts', async ({ kap }) => {
  const documents: Record<string, unknown> = {};
  for (const name of ['openapi', 'asyncapi']) {
    const response = await kap.rest.raw(`/${name}.json`);
    expect(response.status).toBe(200);
    documents[name] = await response.json();
  }
  await expectContractGolden(
    { openapi: schemaFile('openapi.json'), asyncapi: schemaFile('asyncapi.json'), summary: schemaFile('contract.txt') },
    { openapi: documents['openapi'], asyncapi: documents['asyncapi'] },
    { kind: 'schema', refreshCommand: 'pnpm qa:refresh schema' },
  );
});
