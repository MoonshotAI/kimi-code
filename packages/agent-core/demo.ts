import { Agent } from '#/agent';
import { LocalKaos } from '@moonshot-ai/kaos';

const agent = new Agent({
  runtime: {
    kaos: await LocalKaos.create(),
  },
  providerManager: testProviderManager(),
});

agent.config.update({
  modelAlias: 'kimi'
});
agent.tools.initializeBuiltinTools();
