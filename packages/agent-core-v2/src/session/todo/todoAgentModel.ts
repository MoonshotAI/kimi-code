import { z } from 'zod';

import { AgentModel, defineAgentModel, type AgentModelContext } from '#/state/agentModel';

import '#/agent/contextMemory/conversationTime';

import { readTodoItems, type TodoItem } from './todoItem';
import { ToolsUpdateStore, type TodoState } from './todoOps';

export class TodoAgentModel extends AgentModel<TodoState> {
  constructor(context: AgentModelContext) {
    super(context);
    this.on(ToolsUpdateStore, (event) => {
      if (event.key !== 'todo') return;
      this.state = readTodoItems(event.value);
    });
  }

  items(): readonly TodoItem[] {
    return this.state;
  }

  replaceAll(todos: readonly TodoItem[]): Promise<void> {
    return this.emit(
      new ToolsUpdateStore({ agentId: this.agent.agentId, key: 'todo', value: todos }),
    );
  }
}

export const TodoAgentModelDefinition = defineAgentModel({
  id: 'todo',
  model: TodoAgentModel,
  state: {
    initial: (): TodoState => [],
    schema: z.custom<TodoState>(),
  },
  events: [ToolsUpdateStore],
  undoable: true,
});
