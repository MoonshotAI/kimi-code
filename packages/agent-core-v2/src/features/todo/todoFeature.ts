import { ITodoListTool } from '#/agent/tools/todo-list/todo-list';
import { TodoListTool } from '#/agent/tools/todo-list/todoListTool';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { AgentTodo } from '#/session/todo/todoAgentRuntime';

export class TodoFeature extends Feature {
  static override readonly name = 'todo';

  constructor() {
    super();
    this.contributeAgentRuntime(AgentTodo);
    this.contributeTool(ITodoListTool, TodoListTool, { name: 'TodoList', domain: 'todo' });
  }
}

registerFeature(TodoFeature);
