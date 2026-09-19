import {
  ConfigRef,
  createFeature,
  useAgentTools,
  useProviderCatalog,
  type CatalogOAuthRef,
  type FeatureSlots,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';
import { createToken, inject, useExpose, useNode } from '@moonshot-ai/agent-core/kernel/index';
import {
  createKimiDefaultHeaders,
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeBaseUrl,
  parseKimiCodeCustomHeaders,
  type BearerTokenProvider,
  type KimiIdentityOptions,
} from '@moonshot-ai/kimi-code-oauth';

import { OAuthTokensRef } from '../oauth/index';
import { SERVICES_CONFIG_SECTION, type ServicesSection } from '../web/index';

import type { UrlFetcher } from './fetcher';
import { createLocalFetchURLProvider } from './local';
import { createMoonshotFetchURLProvider } from './moonshot';
import { createFetchURLTool } from './tool';

export const WebFetchRef = createToken<WebFetchFace>('web.fetch');

export interface WebFetchFace {
  getUrlFetcher(): UrlFetcher;
}

export interface CreateFetchProps {
  readonly fetchImpl?: typeof fetch;
  readonly identity?: KimiIdentityOptions;
}

export function useWebFetch(): WebFetchFace {
  return inject(WebFetchRef);
}

export function createFetchSlots(props: CreateFetchProps = {}): FeatureSlots {
  let identityHeaders: Record<string, string> | undefined;
  const defaultHeaders = (): Record<string, string> => {
    identityHeaders ??=
      props.identity === undefined ? {} : createKimiDefaultHeaders(props.identity);
    return { ...parseKimiCodeCustomHeaders(), ...identityHeaders };
  };
  return {
    app() {
      const node = useNode();
      const catalog = useProviderCatalog();
      const configEntries = node.providerRef(ConfigRef);
      const oauthEntries = node.providerRef(OAuthTokensRef);
      const local = createLocalFetchURLProvider({ fetchImpl: props.fetchImpl });
      const resolveToken = (ref: CatalogOAuthRef | undefined): BearerTokenProvider | undefined => {
        if (ref === undefined) return undefined;
        return oauthEntries.value.at(-1)?.value.resolve(ref);
      };
      const fromServicesConfig = (): UrlFetcher | undefined => {
        const config = configEntries.value.at(-1)?.value;
        if (config === undefined) return undefined;
        const fetchEntry = config.get<ServicesSection>(SERVICES_CONFIG_SECTION)?.moonshot_fetch;
        if (fetchEntry?.baseUrl === undefined) return undefined;
        return createMoonshotFetchURLProvider({
          baseUrl: fetchEntry.baseUrl,
          tokenProvider: resolveToken(fetchEntry.oauth),
          apiKey: nonEmptyString(fetchEntry.apiKey),
          defaultHeaders: defaultHeaders(),
          customHeaders: fetchEntry.customHeaders,
          localFallback: local,
          fetchImpl: props.fetchImpl,
        });
      };
      const fromManagedOAuth = (): UrlFetcher | undefined => {
        const info = catalog.providerInfo(KIMI_CODE_PROVIDER_NAME);
        if (info?.modelSource !== 'oauth-catalog') return undefined;
        const tokenProvider = resolveToken(info.oauth);
        if (tokenProvider === undefined) return undefined;
        return createMoonshotFetchURLProvider({
          baseUrl: `${(info.baseUrl ?? kimiCodeBaseUrl()).replace(/\/+$/, '')}/fetch`,
          tokenProvider,
          apiKey: undefined,
          defaultHeaders: defaultHeaders(),
          customHeaders: info.customHeaders,
          localFallback: local,
          fetchImpl: props.fetchImpl,
        });
      };
      useExpose(WebFetchRef, {
        getUrlFetcher: () => fromServicesConfig() ?? fromManagedOAuth() ?? local,
      });
    },
    agent() {
      const webFetch = inject(WebFetchRef);
      useAgentTools(createFetchURLTool(webFetch));
    },
  };
}

export function createFetch(props: CreateFetchProps = {}): FeatureSpec {
  return createFeature('fetch', createFetchSlots(props));
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
