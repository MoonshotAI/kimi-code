import { createFeature, type Feature, type FeatureUnits } from '@moonshot-ai/agent-core/app/index';
import { createFacadeToken, useExpose, useInject } from '@moonshot-ai/agent-core/kernel/index';
import {
  createKimiDefaultHeaders,
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeBaseUrl,
  parseKimiCodeCustomHeaders,
  type BearerTokenProvider,
  type KimiIdentityOptions,
} from '@moonshot-ai/kimi-code-oauth';

import { ConfigRef } from '#/features/config/index';
import {
  isOAuthBackedProvider,
  useProviderCatalog,
  type CatalogOAuthRef,
} from '#/features/provider-catalog/index';
import { useAgentTools } from '#/runtime/index';

import { OAuthTokensRef } from '../oauth/index';
import { SERVICES_CONFIG_SECTION, type ServicesSection } from '../web/index';

import type { UrlFetcher } from './fetcher';
import { createLocalFetchURLProvider } from './local';
import { createMoonshotFetchURLProvider } from './moonshot';
import { createFetchURLTool } from './tool';

export const WebFetchRef = createFacadeToken<WebFetchFace>('web.fetch');

export interface WebFetchFace {
  getUrlFetcher(): UrlFetcher;
}

export interface CreateFetchProps {
  readonly fetchImpl?: typeof fetch;
  readonly identity?: KimiIdentityOptions;
}

export function useWebFetch(): WebFetchFace {
  const face = useInject(WebFetchRef).value;
  if (face === undefined) {
    throw new Error('fetch feature is not installed');
  }
  return face;
}

export function createFetchSlots(props: CreateFetchProps = {}): FeatureUnits<void> {
  let identityHeaders: Record<string, string> | undefined;
  const defaultHeaders = (): Record<string, string> => {
    identityHeaders ??=
      props.identity === undefined ? {} : createKimiDefaultHeaders(props.identity);
    return { ...parseKimiCodeCustomHeaders(), ...identityHeaders };
  };
  return {
    app() {
      const catalog = useProviderCatalog();
      const config = useInject(ConfigRef);
      const oauth = useInject(OAuthTokensRef);
      const local = createLocalFetchURLProvider({ fetchImpl: props.fetchImpl });
      const resolveToken = (ref: CatalogOAuthRef | undefined): BearerTokenProvider | undefined => {
        if (ref === undefined) return undefined;
        return oauth.value?.resolve(ref);
      };
      const fromServicesConfig = (): UrlFetcher | undefined => {
        const store = config.value;
        if (store === undefined) return undefined;
        const fetchEntry = store.get<ServicesSection>(SERVICES_CONFIG_SECTION)?.moonshot_fetch;
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
        const info = catalog.value?.providerInfo(KIMI_CODE_PROVIDER_NAME);
        if (info === undefined || !isOAuthBackedProvider(info)) return undefined;
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
      const webFetch = useWebFetch();
      useAgentTools(createFetchURLTool(webFetch));
    },
  };
}

export function createFetch(props: CreateFetchProps = {}): Feature<void> {
  return createFeature('fetch', createFetchSlots(props));
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
