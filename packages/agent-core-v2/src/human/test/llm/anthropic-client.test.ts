import { beforeEach, describe, expect, it, vi } from 'vitest';

const constructor = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(options: unknown) {
      constructor(options);
    }
  },
}));

import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';

describe('anthropic client auth mapping', () => {
  beforeEach(() => {
    constructor.mockClear();
  });

  it('sends a plain apiKey as x-api-key with no bearer token', () => {
    anthropicProtocol.client({ baseUrl: 'https://example.test', apiKey: 'sk-ant-key' }, undefined);

    expect(constructor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-ant-key', authToken: null }),
    );
    const options = constructor.mock.calls[0]?.[0] as {
      defaultHeaders: Record<string, string | null>;
    };
    expect(options.defaultHeaders['authorization']).toBeNull();
  });

  it('maps a bedrock bearer credential to authToken and drops the apiKey', () => {
    anthropicProtocol.client(
      {
        baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/anthropic',
        apiKey: 'bedrock-api-key-token',
        headers: { authorization: 'Bearer bedrock-api-key-token' },
      },
      undefined,
    );

    expect(constructor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: null, authToken: 'bedrock-api-key-token' }),
    );
  });

  it('does not forward the credential authorization header as a duplicate default header', () => {
    anthropicProtocol.client(
      {
        baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/anthropic',
        apiKey: 'bedrock-api-key-token',
        headers: { authorization: 'Bearer bedrock-api-key-token', 'x-custom': 'keep' },
      },
      undefined,
    );

    const options = constructor.mock.calls[0]?.[0] as {
      defaultHeaders: Record<string, string | null>;
    };
    expect(options.defaultHeaders).not.toHaveProperty('authorization');
    expect(options.defaultHeaders['x-custom']).toBe('keep');
  });

  it('preserves a custom bearer header alongside an api key (dual-auth gateway)', () => {
    anthropicProtocol.client(
      {
        baseUrl: 'https://anthropic-gateway.example.test',
        apiKey: 'sk-ant-key',
        headers: { authorization: 'Bearer gateway-token' },
      },
      undefined,
    );

    expect(constructor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-ant-key', authToken: null }),
    );
    const options = constructor.mock.calls[0]?.[0] as {
      defaultHeaders: Record<string, string | null>;
    };
    expect(options.defaultHeaders['authorization']).toBe('Bearer gateway-token');
  });
});
