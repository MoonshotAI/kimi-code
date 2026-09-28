import { createFeature, useProvider, useProviderProtocol } from '@moonshot-ai/agent-core';

import { kimiProtocolBindings, kimiProvider } from './provider';

export const kimi = createFeature('kimi', {
  app() {
    useProvider({ provider: kimiProvider });
    useProviderProtocol({ type: 'kimi', protocols: () => kimiProtocolBindings() });
  },
});
