import { describe, expect, it } from 'vitest';

import {
  CUSTOM_REGISTRY_MODEL_FIELDS,
  MANAGED_KIMI_MODEL_FIELDS,
  mergeRefreshedModelAlias,
} from '../src/model-alias-merge';

describe('mergeRefreshedModelAlias', () => {
  it('preserves overrides while refreshing managed fields', () => {
    const merged = mergeRefreshedModelAlias(
      {
        provider: 'managed:kimi-code',
        model: 'kimi-k2',
        maxContextSize: 262144,
        supportEfforts: ['low'],
        overrides: { supportEfforts: ['low'] },
      },
      {
        provider: 'managed:kimi-code',
        model: 'kimi-k2',
        maxContextSize: 262144,
        supportEfforts: ['low', 'high', 'max'],
      },
      MANAGED_KIMI_MODEL_FIELDS,
    );

    expect(merged.supportEfforts).toEqual(['low', 'high', 'max']);
    expect(merged.overrides).toEqual({ supportEfforts: ['low'] });
  });

  it('drops managed top-level fields when upstream stops declaring them', () => {
    const merged = mergeRefreshedModelAlias(
      {
        provider: 'managed:kimi-code',
        model: 'kimi-k2',
        maxContextSize: 262144,
        supportEfforts: ['low'],
      },
      {
        provider: 'managed:kimi-code',
        model: 'kimi-k2',
        maxContextSize: 262144,
      },
      MANAGED_KIMI_MODEL_FIELDS,
    );

    expect(merged.supportEfforts).toBeUndefined();
  });

  it('keeps custom-registry supportEfforts as user data', () => {
    const merged = mergeRefreshedModelAlias(
      {
        provider: 'registry',
        model: 'gpt-5.5',
        maxContextSize: 131072,
        supportEfforts: ['low', 'high'],
      },
      {
        provider: 'registry',
        model: 'gpt-5.5',
        maxContextSize: 131072,
      },
      CUSTOM_REGISTRY_MODEL_FIELDS,
    );

    expect(merged.supportEfforts).toEqual(['low', 'high']);
  });
});
