import { type ProviderConfig } from '#/provider-catalog/provider/provider';
import { IProviderCatalogService } from '#/provider-catalog/providerCatalogService';

export function stubProviderService(
  providers: Readonly<Record<string, ProviderConfig>> = {},
  ready: Promise<void> = Promise.resolve(),
): IProviderCatalogService {
  return {
    _serviceBrand: undefined,
    ready,
    onDidChangeProviders: () => ({ dispose: () => {} }),
    onDidChangeDefaultProvider: () => ({ dispose: () => {} }),
    getProviderConfig: (name: string) => providers[name],
    listProviderConfigs: () => providers,
    getDefaultProviderId: () => undefined,
    setProviderConfig: async () => {},
    deleteProviderConfig: async () => {},
    loadProviderConfigs: () => {},
    replaceProviderConfigs: async () => {},
    setDefaultProviderId: async () => {},
  } as unknown as IProviderCatalogService;
}
