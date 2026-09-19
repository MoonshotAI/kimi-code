import {
  ConfigRef,
  createFeature,
  useAgentTools,
  useConfigOverlay,
  useConfigSection,
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

import { SERVICES_CONFIG_SECTION, servicesConfigSection, servicesCredentialEnvOverlay, type ServicesSection } from './configSection';
import {
  createMoonshotWebSearchProvider,
  type WebSearchFace,
  type WebSearchProvider,
} from './provider';
import { createWebSearchTool } from './tool';

export const WebSearchRef = createToken<WebSearchFace>('web.search');

export interface CreateWebProps {
  readonly fetchImpl?: typeof fetch;
  readonly identity?: KimiIdentityOptions;
}

export function useWebSearch(): WebSearchFace {
  return inject(WebSearchRef);
}

export function createWebSlots(props: CreateWebProps = {}): FeatureSlots {
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
      useConfigSection(servicesConfigSection);
      useConfigOverlay(servicesCredentialEnvOverlay);
      const resolveToken = (ref: CatalogOAuthRef | undefined): BearerTokenProvider | undefined => {
        if (ref === undefined) return undefined;
        return oauthEntries.value.at(-1)?.value.resolve(ref);
      };
      const fromServicesConfig = (): WebSearchProvider | undefined => {
        const config = configEntries.value.at(-1)?.value;
        if (config === undefined) return undefined;
        const search = config.get<ServicesSection>(SERVICES_CONFIG_SECTION)?.moonshot_search;
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
        const info = catalog.providerInfo(KIMI_CODE_PROVIDER_NAME);
        if (info?.modelSource !== 'oauth-catalog') return undefined;
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
      const web = inject(WebSearchRef);
      if (web.getProvider() === undefined) return;
      useAgentTools(createWebSearchTool(web));
    },
  };
}

export function createWeb(props: CreateWebProps = {}): FeatureSpec {
  return createFeature('web', createWebSlots(props));
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
