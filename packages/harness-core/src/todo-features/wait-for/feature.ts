import { createFeature, useAgentTools, useWaitForTasks } from '#/app/index';

import { createWaitForTool } from './tool';

export const waitFor = createFeature('wait-for', {
  agent() {
    useAgentTools(createWaitForTool(useWaitForTasks()));
  },
});
