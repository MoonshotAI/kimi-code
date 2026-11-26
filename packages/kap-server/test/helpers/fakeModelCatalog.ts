import {
  ProviderCatalogService,
  type IProviderCatalogService,
} from '@moonshot-ai/agent-core-v2/provider-catalog/providerCatalogService';

export function fakeModelCatalog(): IProviderCatalogService {
  const service = new ProviderCatalogService();
  service.loadProviderConfigs({}, undefined);
  service.loadModelRecords({}, undefined);
  return service;
}
