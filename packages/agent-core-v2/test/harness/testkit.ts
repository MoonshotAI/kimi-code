import { modelFixtures, verifyModelOnce, type ModelFixtures, type ModelFixtureDefinitions, type Use } from '@moonshot-ai/testkit/vitest';

import { createTestAgent, type AgentTestContext, type TestAgentInput } from './agent';

export interface TestkitAgentFixtures extends ModelFixtures {
  agent: AgentTestContext;
}

export interface TestkitAgentFixtureDefinitions extends ModelFixtureDefinitions {
  readonly agent: (context: ModelFixtures, use: Use<AgentTestContext>) => Promise<void>;
}

export function testkitAgentFixtures(...inputs: readonly TestAgentInput[]): TestkitAgentFixtureDefinitions {
  return {
    ...modelFixtures(),
    agent: async ({ model }, use) => {
      const agent = createTestAgent(...inputs, { model });
      try {
        await use(agent);
        verifyModelOnce(model);
      } finally {
        await agent.dispose();
      }
    },
  };
}
