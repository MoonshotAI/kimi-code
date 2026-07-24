/**
 * `provider` config-section tests — the `providers` section registration
 * (schema + env bindings + strip hook, self-registered by the app/kosongConfig
 * persistence wrapper) and the TOML/env helper transforms.
 *
 * The registry itself (`ProviderService`) is a pure in-memory store covered
 * by `test/kosong/provider/providerService.test.ts`; persistence through the
 * config bridge is covered by `test/app/kosongConfig/kosongConfigService.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { ConfigRegistry } from '#/app/config/configService';
import {
  ENV_MODEL_PROVIDER_KEY,
  PROVIDERS_SECTION,
  providersEnvBindings,
  providersFromToml,
  providersToToml,
  stripProvidersEnv,
} from '#/app/kosongConfig/configSection';

describe('providers config section', () => {
  it('self-registers the schema with the env bindings and strip hook', () => {
    const registry = new ConfigRegistry();
    expect(registry.getSection(PROVIDERS_SECTION)).toMatchObject({
      domain: PROVIDERS_SECTION,
      env: providersEnvBindings,
      stripEnv: stripProvidersEnv,
    });
  });
});

describe('provider config section helpers', () => {
  it('declares KIMI_MODEL_* bindings for the env provider', () => {
    expect(providersEnvBindings).toEqual({
      [ENV_MODEL_PROVIDER_KEY]: {
        apiKey: 'KIMI_MODEL_API_KEY',
        type: 'KIMI_MODEL_PROVIDER_TYPE',
        baseUrl: 'KIMI_MODEL_BASE_URL',
      },
    });
  });

  it('strips only the env provider before write-back', () => {
    expect(
      stripProvidersEnv({
        user: { type: 'kimi', apiKey: 'sk-user' },
        [ENV_MODEL_PROVIDER_KEY]: { type: 'openai', apiKey: 'sk-env' },
      }),
    ).toEqual({
      user: { type: 'kimi', apiKey: 'sk-user' },
    });
  });

  it('maps provider entries from TOML snake_case to camelCase', () => {
    expect(
      providersFromToml({
        kimi: {
          type: 'kimi',
          api_key: 'sk',
          base_url: 'https://api.example.com/v1',
          custom_headers: { 'X-Test': '1' },
          oauth: { storage: 'file', key: 'token', oauth_host: 'https://auth.example.com' },
        },
      }),
    ).toEqual({
      kimi: {
        type: 'kimi',
        apiKey: 'sk',
        baseUrl: 'https://api.example.com/v1',
        customHeaders: { 'X-Test': '1' },
        oauth: { storage: 'file', key: 'token', oauthHost: 'https://auth.example.com' },
      },
    });
  });

  it('maps provider entries back to TOML snake_case', () => {
    expect(
      providersToToml(
        {
          kimi: {
            type: 'kimi',
            apiKey: 'sk',
            baseUrl: 'https://api.example.com/v1',
            customHeaders: { 'X-Test': '1' },
            oauth: { storage: 'file', key: 'token', oauthHost: 'https://auth.example.com' },
          },
        },
        {},
      ),
    ).toEqual({
      kimi: {
        type: 'kimi',
        api_key: 'sk',
        base_url: 'https://api.example.com/v1',
        custom_headers: { 'X-Test': '1' },
        oauth: { storage: 'file', key: 'token', oauth_host: 'https://auth.example.com' },
      },
    });
  });
});
