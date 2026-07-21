/**
 * `kosong/protocol` protocol identity — wire enum, adapter config, and the
 * registry decorator.
 *
 * Locks the decision-1 invariants: the protocol enum holds only the four
 * real wire formats (a vendor name is not a protocol and is rejected, and
 * `vertexai` is rejected too — Vertex AI is a `providerOptions` mode of the
 * `google-genai` base, not a wire format), while `providerType` on the
 * adapter config stays a free-form string so external packages can register
 * vendors without touching this layer.
 */

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
    // A vendor is `{ base, traits }`, never a protocol.
    expect(ProtocolSchema.safeParse('kimi').success).toBe(false);
    // Vertex AI is a providerOptions mode of the google-genai base now.
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
