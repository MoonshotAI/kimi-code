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

import { ConfigRef, useConfigOverlay, useConfigSection } from '#/features/config/index';
import {
  isOAuthBackedProvider,
  useProviderCatalog,
  type CatalogOAuthRef,
} from '#/features/provider-catalog/index';
import { useAgentTools } from '#/runtime/index';

import { OAuthTokensRef } from '../oauth/index';

import {
  SERVICES_CONFIG_SECTION,
  servicesConfigSection,
  servicesCredentialEnvOverlay,
  type ServicesSection,
} from './configSection';
import {
  createMoonshotWebSearchProvider,
  type WebSearchFace,
  type WebSearchProvider,
} from './provider';
import { createWebSearchTool } from './tool';

export const WebSearchRef = createFacadeToken<WebSearchFace>('web.search');

export interface CreateWebProps {
  readonly fetchImpl?: typeof fetch;
  readonly identity?: KimiIdentityOptions;
}

export function useWebSearch(): WebSearchFace {
  const face = useInject(WebSearchRef).value;
  if (face === undefined) {
    throw new Error('web feature is not installed');
  }
  return face;
}

export function createWebSlots(props: CreateWebProps = {}): FeatureUnits<void> {
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
      useConfigSection(servicesConfigSection);
      useConfigOverlay(servicesCredentialEnvOverlay);
      const resolveToken = (ref: CatalogOAuthRef | undefined): BearerTokenProvider | undefined => {
        if (ref === undefined) return undefined;
        return oauth.value?.resolve(ref);
      };
      const fromServicesConfig = (): WebSearchProvider | undefined => {
        const store = config.value;
        if (store === undefined) return undefined;
        const search = store.get<ServicesSection>(SERVICES_CONFIG_SECTION)?.moonshot_search;
        if (search?.baseUrl === undefined) return undefined;
        return createMoonshotWebSearchProvider({
          baseUrl: search.baseUrl,
          tokenProvider: resolveToken(search.oauth),
          apiKey: nonEmptyString(search.apiKey),
          defaultHeaders: defaultHeaders(),
          customHeaders: search.customHeaders,
          fetchImpl: props.fetchImpl,
        });
      };
      const fromManagedOAuth = (): WebSearchProvider | undefined => {
        const info = catalog.value?.providerInfo(KIMI_CODE_PROVIDER_NAME);
        if (info === undefined || !isOAuthBackedProvider(info)) return undefined;
        const tokenProvider = resolveToken(info.oauth);
        if (tokenProvider === undefined) return undefined;
        return createMoonshotWebSearchProvider({
          baseUrl: `${(info.baseUrl ?? kimiCodeBaseUrl()).replace(/\/+$/, '')}/search`,
          tokenProvider,
          apiKey: undefined,
          defaultHeaders: defaultHeaders(),
          customHeaders: info.customHeaders,
          fetchImpl: props.fetchImpl,
        });
      };
      useExpose(WebSearchRef, {
        getProvider: () => fromServicesConfig() ?? fromManagedOAuth(),
      });
    },
    agent() {
      const web = useWebSearch();
      if (web.getProvider() === undefined) return;
      useAgentTools(createWebSearchTool(web));
    },
  };
}

export function createWeb(props: CreateWebProps = {}): Feature<void> {
  return createFeature('web', createWebSlots(props));
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
