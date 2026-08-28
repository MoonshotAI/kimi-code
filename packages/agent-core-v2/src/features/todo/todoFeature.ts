import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { TodoListTool } from '#/features/todo/tools/todo-list/todoListTool';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { todoAgentRuntimeProvider } from '#/features/todo/todoAgentRuntime';

export class TodoFeature extends Feature {
  static override readonly name = 'todo';

  constructor() {
    super();
    this.contributeAgentRuntime(todoAgentRuntimeProvider);
    this.contributeTool({
      name: 'TodoList',
      domain: 'todo',
      create: (ctx) => new TodoListTool(ctx.get(IAgentLifecycleService), ctx.host.scopeContext),
    });
  }
}

registerFeature(TodoFeature);
