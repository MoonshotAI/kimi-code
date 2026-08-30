import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { taskAgentRuntimeProvider } from './taskAgentRuntime';

import './sessionTaskView';
import './tools/task-list/taskListTool';
import './tools/task-output/taskOutputTool';
import './tools/task-stop/taskStopTool';
import './tools/task-wait/taskWaitTool';

export class TaskFeature extends Feature {
  static override readonly name = 'task';

  constructor() {
    super();
    this.contributeAgentRuntime(taskAgentRuntimeProvider);
  }
}

registerFeature(TaskFeature);
