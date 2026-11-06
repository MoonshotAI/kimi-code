import { beforeEach, describe, expect, it, vi } from 'vitest';

const constructor = vi.hoisted(() => vi.fn());

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    constructor(options: unknown) {
      constructor(options);
    }
  },
}));

import { googleGenAIProtocol } from '#/llm/builtin/protocol/google-genai/index';

describe('google-genai client base URL', () => {
  beforeEach(() => {
    constructor.mockClear();
  });

  it.each([
    ['https://gateway.example.test/v1beta', 'https://gateway.example.test/'],
    ['https://gateway.example.test/v1beta/', 'https://gateway.example.test/'],
    ['https://gateway.example.test/proxy/v1beta', 'https://gateway.example.test/proxy'],
    ['https://gateway.example.test', 'https://gateway.example.test'],
  ])('strips a trailing Gemini version from %s', (baseUrl, expected) => {
    googleGenAIProtocol.client({ baseUrl, apiKey: 'key' }, undefined);

    expect(constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'key',
        httpOptions: { baseUrl: expected },
      }),
    );
  });

  it('strips the Vertex version instead of the Gemini version', () => {
    googleGenAIProtocol.client(
      { baseUrl: 'https://gateway.example.test/v1beta1', apiKey: 'key' },
      { vertexai: true },
    );

    expect(constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        vertexai: true,
        httpOptions: { baseUrl: 'https://gateway.example.test/' },
      }),
    );
  });

  it('leaves an invalid base URL for the SDK to reject', () => {
    googleGenAIProtocol.client({ baseUrl: 'not a url', apiKey: 'key' }, undefined);

    expect(constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: { baseUrl: 'not a url' },
      }),
    );
  });
});
