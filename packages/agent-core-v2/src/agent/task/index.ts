/**
 * `task` domain barrel — re-exports the Agent task manager contract
 * (`task`) and its scoped service (`taskService`), plus a side-effect import
 * of each task tool so its `registerTool(...)` call runs at module load.
 * Importing this barrel wires `IAgentTaskService`
 * into the scope registry and adds the three tools (`TaskList` / `TaskOutput`
 * / `TaskStop`) to the tool contribution list.
 */

import './configSection';
import './tools/task-list';
import './tools/task-output';
import './tools/task-stop';

export * from './task';
export * from './taskOps';
export * from './taskService';
