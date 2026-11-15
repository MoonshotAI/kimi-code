import { IModelCatalog } from '@moonshot-ai/agent-core-v2';

export function fakeModelCatalog(): IModelCatalog {
  return {
    _serviceBrand: undefined,
    get: () => {
      throw new Error('modelCatalog.get not exercised in this test');
    },
    findByName: () => [],
    listModels: async () => [],
    listProviders: async () => [],
    getProvider: async () => {
      throw new Error('modelCatalog.getProvider not exercised in this test');
    },
    setDefaultModel: async () => {
      throw new Error('modelCatalog.setDefaultModel not exercised in this test');
    },
  };
}
