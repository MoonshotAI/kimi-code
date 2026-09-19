import { createFeature } from '#/feature/feature';
import { useAgentTools, useWaitForTasks } from '#/feature/contribution-hooks';

import { createWaitForTool } from './tool';

export const waitFor = createFeature('wait-for', {
  agent() {
    useAgentTools(createWaitForTool(useWaitForTasks()));
  },
});
