import { LifecycleScope } from '#/app/scopes';
import { ITodoListTool } from '#/agent/tools/todo-list/todo-list';
import { TodoListTool } from '#/agent/tools/todo-list/todoListTool';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { SessionTodoService } from '#/session/todo/sessionTodoService';
import { TodoAgentEffectDefinition } from '#/session/todo/todoAgentEffect';
import { TodoAgentModelDefinition } from '#/session/todo/todoAgentModel';

export class TodoFeature extends Feature {
  static override readonly name = 'todo';

  constructor() {
    super();
    this.contributeAgentModel(TodoAgentModelDefinition);
    this.contributeAgentEffect(TodoAgentEffectDefinition);
    this.contributeService(LifecycleScope.Session, ISessionTodoService, SessionTodoService);
    this.contributeTool(ITodoListTool, TodoListTool, { name: 'TodoList', domain: 'todo' });
  }
}

registerFeature(TodoFeature);
