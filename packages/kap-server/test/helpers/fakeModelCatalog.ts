import { IModelCatalog } from '@moonshot-ai/agent-core-v2';

export function fakeModelCatalog(): IModelCatalog {
  return {
    _serviceBrand: undefined,
    get: () => {
      throw new Error('modelCatalog.get not exercised in this test');
    },
    getRequester: () => {
      throw new Error('modelCatalog.getRequester not exercised in this test');
    },
    inspect: () => {
      throw new Error('modelCatalog.inspect not exercised in this test');
    },
    ping: () => {
      throw new Error('modelCatalog.ping not exercised in this test');
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
