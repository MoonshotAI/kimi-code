import {
  Disposable,
  registerSingleton,
  SyncDescriptor,
} from "#/_base/di";
import {
  TODO_LIST_TOOL_NAME,
  TODO_STORE_KEY,
  TodoListTool,
  readTodoItems,
  type TodoItem,
} from '../../../tools/builtin/state/todo-list';
import {
  TODO_LIST_REMINDER_VARIANT,
  todoListStaleReminder,
} from './todoListReminder';
import { IContextMemory } from '../contextMemory/contextMemory';
import { IDynamicInjector } from '../dynamicInjector/dynamicInjector';
import { IProfileService } from '../profile/profile';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import { IToolStoreService } from '../toolStore/toolStore';
import { ITodoListService } from './todoList';

export class TodoListService extends Disposable implements ITodoListService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @IProfileService private readonly profile: IProfileService,
    @IToolStoreService private readonly toolStore: IToolStoreService,
    @IToolRegistry toolRegistry: IToolRegistry,
    @IDynamicInjector dynamicInjector: IDynamicInjector,
  ) {
    super();
    this._register(toolRegistry.register(new TodoListTool(toolStore)));
    this._register(
      dynamicInjector.register(TODO_LIST_REMINDER_VARIANT, () => this.staleReminder()),
    );
  }

  private getTodos(): readonly TodoItem[] {
    return readTodoItems(this.toolStore.data()[TODO_STORE_KEY]);
  }

  private staleReminder(): string | undefined {
    return todoListStaleReminder({
      active: this.profile.isToolActive(TODO_LIST_TOOL_NAME, 'builtin'),
      history: this.context.getHistory(),
      todos: this.getTodos(),
    });
  }
}

registerSingleton(
  ITodoListService,
  new SyncDescriptor(TodoListService, [], false),
);
