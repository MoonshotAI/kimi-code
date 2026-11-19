import { expect, test as base } from 'vitest';

import { checkArtifact } from './support/artifacts';
import { scenarioFixtures, type ScenarioFixtures } from './support/scenario';

const test = base.extend<ScenarioFixtures>(scenarioFixtures({ serverVersion: '0.0.0-fixture' }));

test('publishes the reviewed REST and WebSocket field contracts', async ({ kap }) => {
  for (const name of ['openapi', 'asyncapi']) {
    const response = await kap.rest.raw('/' + name + '.json');
    expect(response.status).toBe(200);
    const document = await response.json();
    await checkArtifact(new URL(`../../packages/kap-server/schema/${name}.json`, import.meta.url), document, 'schema');
  }
});
