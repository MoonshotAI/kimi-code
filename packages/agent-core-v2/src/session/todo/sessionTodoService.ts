/**
 * `todo` domain (L4) — `ISessionTodoService` implementation.
 *
 * Holds the session's shared todo list as a stateless facade over the main
 * agent's `TodoModel`: `getTodos` reads `wire.getModel(TodoModel)` live, and
 * every mutation only dispatches a `tools.update_store` Op to the main agent's
 * wire (the single source of truth and replayable timeline), then emits
 * `onDidChange` from the rebuilt Model. The service keeps no list copy of its
 * own, so the live view and the post-replay view can never drift. Binds the
 * `TodoListTool` and the stale-todo reminder into every agent (`onDidCreate`),
 * borrowing each agent's services through its `IAgentScopeHandle.accessor`.
 * Per-agent bindings are disposed when the agent is disposed. Bound at
 * Session scope.
 *
 * The session owns the todo facade and tool bindings, while the main Agent wire
 * owns the replayable state. This is an explicit cross-scope orchestration
 * boundary: there is no second session-level wire aggregate or journal.
 */

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { type IAgentScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';

import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IWireService } from '#/wire/wire';

import { ISessionTodoService } from './sessionTodo';
import { TodoModel, todoSet } from './todoOps';
import { TODO_LIST_TOOL_NAME, type TodoItem } from './todoItem';
import { TODO_LIST_REMINDER_VARIANT, todoListStaleReminder } from './todoListReminder';

const MAIN_AGENT_ID = 'main';

export class SessionTodoService extends Disposable implements ISessionTodoService {
  declare readonly _serviceBrand: undefined;

  private readonly onDidChangeEmitter = this._register(new Emitter<readonly TodoItem[]>());
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly agentBindings = new Map<string, IDisposable[]>();

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {
    super();

    this._register(
      this.agentLifecycle.onDidCreate((handle) => {
        this.bindAgent(handle);
      }),
    );
    this._register(
      this.agentLifecycle.onDidDispose((agentId) => this.disposeAgentBindings(agentId)),
    );

    for (const handle of this.agentLifecycle.list()) {
      this.bindAgent(handle);
    }

    this._register(
      toDisposable(() => {
        for (const agentId of Array.from(this.agentBindings.keys())) {
          this.disposeAgentBindings(agentId);
        }
      }),
    );
  }

  getTodos(): readonly TodoItem[] {
    const main = this.agentLifecycle.get(MAIN_AGENT_ID);
    if (main === undefined) return [];
    return main.accessor.get(IWireService).getModel(TodoModel);
  }

  setTodos(todos: readonly TodoItem[]): void {
    const next: readonly TodoItem[] = todos.map((todo) => ({
      title: todo.title,
      status: todo.status,
    }));
    this.dispatchTodoSet(next);
  }

  clear(): void {
    this.setTodos([]);
  }

  private dispatchTodoSet(todos: readonly TodoItem[]): void {
    const main = this.agentLifecycle.get(MAIN_AGENT_ID);
    if (main === undefined) return;
    const wire = main.accessor.get(IWireService);
    wire.dispatch(todoSet({ key: 'todo', value: todos }));
    this.onDidChangeEmitter.fire(wire.getModel(TodoModel));
  }

  private bindAgent(handle: IAgentScopeHandle): void {
    const injector = handle.accessor.get(IAgentContextInjectorService);
    this.trackAgentBinding(
      handle.id,
      injector.register(TODO_LIST_REMINDER_VARIANT, () => this.staleReminder(handle)),
    );
  }

  private staleReminder(handle: IAgentScopeHandle): string | undefined {
    const memory = handle.accessor.get(IAgentContextMemoryService);
    const toolPolicy = handle.accessor.get(IAgentToolPolicyService);
    return todoListStaleReminder({
      active: toolPolicy.isToolActive(TODO_LIST_TOOL_NAME, 'builtin'),
      history: memory.get(),
      todos: this.getTodos(),
    });
  }

  private trackAgentBinding(agentId: string, disposable: IDisposable): void {
    const list = this.agentBindings.get(agentId);
    if (list === undefined) {
      this.agentBindings.set(agentId, [disposable]);
    } else {
      list.push(disposable);
    }
  }

  private disposeAgentBindings(agentId: string): void {
    const bindings = this.agentBindings.get(agentId);
    if (bindings === undefined) return;
    for (const disposable of bindings) {
      disposable.dispose();
    }
    this.agentBindings.delete(agentId);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTodoService,
  SessionTodoService,
  InstantiationType.Eager,
  'todo',
);
