import { createFeature, useProvider } from '@moonshot-ai/agent-core';

import { kimiProvider } from './provider';

export const kimi = createFeature('kimi', {
  app() {
    useProvider({ provider: kimiProvider });
  },
});
