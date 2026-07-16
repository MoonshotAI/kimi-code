/**
 * Dual-backend rewrite of scenario `06-model-catalog`: catalog and auth read
 * models respond, a provider round-trips by id, and setting the default
 * model echoes it back. No live model calls required.
 */
import { expect, it } from 'vitest';

import { defineDualSuite } from '../../helpers/dual.js';

defineDualSuite('model catalog', {}, ({ klient }) => {
  it('catalog + auth read models respond', async () => {
    const k = klient();

    const models = await k.global.catalog.listModels();
    const providers = await k.global.catalog.listProviders();
    expect(Array.isArray(models)).toBe(true);
    expect(Array.isArray(providers)).toBe(true);

    if (providers.length > 0) {
      const provider = await k.global.catalog.getProvider(providers[0]!.id);
      expect(provider.id).toBe(providers[0]!.id);
    }

    expect(Array.isArray(await k.global.auth.summarize())).toBe(true);

    if (models.length > 0) {
      const result = await k.global.catalog.setDefaultModel(models[0]!.model);
      expect(result.default_model).toBe(models[0]!.model);
    }
  }, 60_000);
});
