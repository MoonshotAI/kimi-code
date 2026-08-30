import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IOAuthService } from '#/app/auth/auth';
import {
  buildAgentIdentitySnapshot,
  IAgentIdentity,
  type AgentIdentitySnapshot,
} from '#/app/agentIdentity/agentIdentity';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IProviderService, type ProviderConfig } from '#/kosong/provider/provider';
import { IWebSearchProviderService } from '#/app/auth/webSearch/webSearch';
import { WebSearchProviderService } from '#/app/auth/webSearch/webSearchService';
import { SUBSCRIPTION_SECTION } from '#/app/subscription/configSection';
import '#/kosong/provider/providers/kimi/kimi.contrib';

import { stubAgentIdentity } from '../agentIdentity/stubs';

const OAUTH_PROVIDER = 'managed:kimi-code';
const HOST_HEADERS = {
  'User-Agent': 'kimi-code-cli/test',
  'X-Msh-Device-Id': 'device-test',
};

describe('WebSearchProviderService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: Record<string, ProviderConfig>;
  let subscriptionConfig: Record<string, boolean> | undefined;
  let resolveTokenProvider: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    subscriptionConfig = undefined;
    resolveTokenProvider = vi
      .fn()
      .mockReturnValue({ getAccessToken: async () => 'access-token' });
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IProviderService, {
          get: ((name: string) => providers[name]) as IProviderService['get'],
        });
        reg.definePartialInstance(IOAuthService, {
          resolveTokenProvider:
            resolveTokenProvider as unknown as IOAuthService['resolveTokenProvider'],
        });
        const snapshot = (): AgentIdentitySnapshot =>
          buildAgentIdentitySnapshot({ slug: undefined, hostRequestHeaders: HOST_HEADERS });
        reg.defineInstance(IAgentIdentity, {
          _serviceBrand: undefined,
          resolved: () => Promise.resolve(snapshot()),
          current: snapshot,
        });
        reg.definePartialInstance(IBootstrapService, {
          args: { requestHeaders: HOST_HEADERS },
        });
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) =>
            domain === SUBSCRIPTION_SECTION
              ? subscriptionConfig
              : undefined) as IConfigService['get'],
        });
        reg.define(IWebSearchProviderService, WebSearchProviderService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
    vi.unstubAllGlobals();
  });

  function service(): IWebSearchProviderService {
    return ix.get(IWebSearchProviderService);
  }

  it('reports no provider when web_search is disabled, even with a managed OAuth provider', () => {
    subscriptionConfig = { web_search: false };
    expect(service().hasWebSearchProvider()).toBe(false);
    expect(service().getWebSearchProvider()).toBeUndefined();
  });

  it('reports the managed provider when web_search is enabled', () => {
    subscriptionConfig = { web_search: true };
    expect(service().hasWebSearchProvider()).toBe(true);
    expect(service().getWebSearchProvider()).toBeDefined();
  });

  it('reports the managed provider when the subscription section is absent', () => {
    subscriptionConfig = undefined;
    expect(service().hasWebSearchProvider()).toBe(true);
    expect(service().getWebSearchProvider()).toBeDefined();
  });
});
