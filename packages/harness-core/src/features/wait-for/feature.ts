import { createFeature } from '@moonshot-ai/agent-core/app/index';

import { useAgentTools, useWaitForTasks } from '#/runtime/index';

import { createWaitForTool } from './tool';

export const waitFor = createFeature('wait-for', {
  agent() {
    useAgentTools(createWaitForTool(useWaitForTasks()));
  },
});
