#!/usr/bin/env node
/**
 * Scenario 06 — model and provider catalog APIs.
 *
 * Exercises:
 *   - GET /auth
 *   - GET /models
 *   - GET /providers
 *   - GET /providers/{id}
 *   - POST /models/{id}:set_default when the current default appears in /models
 */
import assert from 'node:assert/strict';

import { DaemonClient } from '../src/index';

const KIMI_SERVER_URL = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';

async function main() {
  console.log(`▶ server at ${KIMI_SERVER_URL}`);
  const client = new DaemonClient({ baseUrl: KIMI_SERVER_URL });

  try {
    const auth = await client.getAuth();
    const models = await client.listModels();
    const providers = await client.listProviders();
    assert.ok(Array.isArray(models.items), 'GET /models returns items[]');
    assert.ok(Array.isArray(providers.items), 'GET /providers returns items[]');
    console.log(
      `▶ catalog: models=${models.items.length} providers=${providers.items.length} default=${auth.default_model ?? '<none>'}`,
    );

    const firstProvider = providers.items[0];
    if (firstProvider !== undefined) {
      const provider = await client.getProvider(firstProvider.id);
      assert.equal(provider.id, firstProvider.id, 'GET /providers/{id} returns the requested provider');
      console.log(`▶ catalog: provider ${provider.id} status=${provider.status}`);
    }

    const defaultModel = auth.default_model;
    if (defaultModel === null || !models.items.some((item) => item.model === defaultModel)) {
      console.log('▶ catalog: set_default skipped because current default is not in /models');
      console.log('✓ 06-model-catalog: catalog reads round-tripped');
      return;
    }

    const setDefault = await client.setDefaultModel(defaultModel);
    assert.equal(setDefault.default_model, defaultModel);
    assert.equal(setDefault.model.model, defaultModel);
    console.log(`▶ catalog: POST /models/${defaultModel}:set_default returned current default`);

    console.log('✓ 06-model-catalog: model/provider catalog round-tripped');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('✗ 06-model-catalog failed:', err);
  process.exit(1);
});
