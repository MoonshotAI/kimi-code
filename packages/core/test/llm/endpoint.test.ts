import { describe, expect, it } from 'vitest';

import {
  mergeHeaders,
  resolveEndpoint,
  resolveEndpointDeclaration,
} from '#/llm/endpoint';
import {
  anthropicEndpoint,
  geminiEndpoint,
  kimiEndpoint,
  vertexEndpoint,
} from '#/llm/builtin/provider/endpoints';

describe('LLM endpoint resolution', () => {
  it('as an API consumer, I want default and explicit endpoints resolved at request time', () => {
    expect(resolveEndpointDeclaration(kimiEndpoint, {})).toMatchObject({
      baseUrl: 'https://api.moonshot.ai/v1',
      baseUrlIsDefault: true,
    });
    expect(resolveEndpointDeclaration(kimiEndpoint, {
      KIMI_API_KEY: 'key-1',
      KIMI_BASE_URL: 'https://example.test/v1',
    })).toMatchObject({
      apiKey: 'key-1',
      apiKeyEnvName: 'KIMI_API_KEY',
      baseUrl: 'https://example.test/v1',
      baseUrlEnvName: 'KIMI_BASE_URL',
    });
    expect(resolveEndpointDeclaration([anthropicEndpoint, geminiEndpoint], {
      GOOGLE_API_KEY: 'google-key',
      ANTHROPIC_BASE_URL: 'https://example.test/anthropic',
    })).toMatchObject({
      apiKey: 'google-key',
      apiKeyEnvName: 'GOOGLE_API_KEY',
      baseUrl: 'https://example.test/anthropic',
      baseUrlEnvName: 'ANTHROPIC_BASE_URL',
    });
    expect(resolveEndpointDeclaration(vertexEndpoint, {
      VERTEXAI_API_KEY: 'vertex-key',
      GOOGLE_VERTEX_BASE_URL: 'https://example.test/vertex',
    })).toMatchObject({
      apiKey: 'vertex-key',
      baseUrl: 'https://example.test/vertex',
    });
  });

  it('as an API consumer, I want credential headers merged with credential precedence', async () => {
    const endpoint = await resolveEndpoint({
      baseUrl: 'https://example.test/v1',
      headers: { 'x-shared': 'endpoint', 'x-endpoint': 'yes' },
      credentials: {
        resolve: () => ({
          apiKey: 'key-1',
          headers: { 'x-shared': 'credential', 'x-credential': 'yes' },
        }),
      },
    });
    expect(endpoint).toEqual({
      baseUrl: 'https://example.test/v1',
      apiKey: 'key-1',
      headers: {
        'x-shared': 'credential',
        'x-endpoint': 'yes',
        'x-credential': 'yes',
      },
      fetch: undefined,
    });
    expect(mergeHeaders(undefined, {}, { 'x-test': '1' })).toEqual({ 'x-test': '1' });
    expect(mergeHeaders(undefined, {})).toBeUndefined();
  });
});
