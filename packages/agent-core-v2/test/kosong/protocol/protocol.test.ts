import { describe, expect, it } from 'vitest';

import {
  IProtocolAdapterRegistry,
  ProtocolSchema,
  type ProtocolAdapterConfig,
} from '#/kosong/protocol/protocol';

describe('ProtocolSchema', () => {
  it('accepts the four real wire protocols', () => {
    for (const protocol of [
      'anthropic',
      'openai',
      'openai_responses',
      'google-genai',
    ]) {
      expect(ProtocolSchema.parse(protocol)).toBe(protocol);
    }
  });

  it('rejects vendor names and unknown values', () => {
    expect(ProtocolSchema.safeParse('kimi').success).toBe(false);
    expect(ProtocolSchema.safeParse('vertexai').success).toBe(false);
    expect(ProtocolSchema.safeParse('azure').success).toBe(false);
    expect(ProtocolSchema.safeParse('').success).toBe(false);
    expect(ProtocolSchema.safeParse(42).success).toBe(false);
  });
});

describe('ProtocolAdapterConfig', () => {
  it('carries a free-form providerType string, unenumerated at parse time', () => {
    const config: ProtocolAdapterConfig = {
      protocol: 'openai',
      providerType: 'vendor-registered-elsewhere',
      modelName: 'vendor-model-1',
    };
    expect(config.providerType).toBe('vendor-registered-elsewhere');

    const withoutVendor: ProtocolAdapterConfig = {
      protocol: 'anthropic',
      modelName: 'claude-sonnet-4',
    };
    expect(withoutVendor.providerType).toBeUndefined();
  });
});

describe('IProtocolAdapterRegistry', () => {
  it('keeps the established DI identity', () => {
    expect(IProtocolAdapterRegistry.toString()).toBe('protocolAdapterRegistry');
  });
});
