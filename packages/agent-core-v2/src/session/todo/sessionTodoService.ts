import type { CollectionView } from '#/_base/di/collection';
import { toDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { Emitter } from '#/_base/event';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { agentSpaceOf } from '#/agent/agentContext/agentSpace';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { ContextUndone } from '#/agent/undo/undoService';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  AgentEffectContribution,
  type AgentEffectDefinition,
} from '#/state/agentEffect';
import {
  AgentModelContribution,
  type AgentModelDefinition,
  type DomainResourceRuntime,
} from '#/state/agentModel';

import { ISessionTodoService, type TodoChange } from './sessionTodo';
import { TodoAgentEffectDefinition } from './todoAgentEffect';
import { TodoAgentModelDefinition } from './todoAgentModel';
import { TODO_LIST_TOOL_NAME, type TodoItem } from './todoItem';
import { TODO_LIST_REMINDER_VARIANT } from './todoListReminder';

export class SessionTodoService extends Service implements ISessionTodoService {
  declare readonly _serviceBrand: undefined;

  private readonly onDidChangeEmitter = this._register(new Emitter<TodoChange>());
  readonly onDidChange = this.onDidChangeEmitter.event;
  private readonly effects = new Map<string, DomainResourceRuntime>();

  constructor(
    @AgentModelContribution
    private readonly models: CollectionView<AgentModelDefinition<any, any>>,
    @AgentEffectContribution
    private readonly effectDefinitions: CollectionView<AgentEffectDefinition<any, any>>,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {
    super();
    this._register(
      this.effectDefinitions.onDidChange(({ removed }) => {
        if (!removed.includes(TodoAgentEffectDefinition as AgentEffectDefinition<any, any>)) return;
        for (const agentId of this.effects.keys()) this.disposeEffect(agentId);
      }),
    );
    this._register(
      this.agentLifecycle.onDidDispose((agent) => {
        this.disposeEffect(agent.agentId);
      }),
    );
    this._register(
      toDisposable(() => {
        for (const agentId of this.effects.keys()) this.disposeEffect(agentId);
      }),
    );
  }

  async getTodos(agent: AgentContext): Promise<readonly TodoItem[]> {
    this.requireDefinitions();
    const space = agentSpaceOf(agent);
    this.ensureEffect(agent);
    return space.use(TodoAgentModelDefinition, (model) => model.items());
  }

  async setTodos(agent: AgentContext, todos: readonly TodoItem[]): Promise<void> {
    this.requireDefinitions();
    const next: readonly TodoItem[] = todos.map((todo) => ({
      title: todo.title,
      status: todo.status,
    }));
    const space = agentSpaceOf(agent);
    this.ensureEffect(agent);
    await space.use(TodoAgentModelDefinition, (model) => model.replaceAll(next));
    this.fireChange(agent, space.use(TodoAgentModelDefinition, (model) => model.items()));
  }

  clear(agent: AgentContext): Promise<void> {
    return this.setTodos(agent, []);
  }

  private requireDefinitions(): void {
    if (!this.models.items.includes(TodoAgentModelDefinition as AgentModelDefinition<any, any>)) {
      throw new Error('resource definition is unavailable');
    }
    if (
      !this.effectDefinitions.items.includes(
        TodoAgentEffectDefinition as AgentEffectDefinition<any, any>,
      )
    ) {
      throw new Error('resource definition is unavailable');
    }
  }

  private ensureEffect(agent: AgentContext): void {
    if (this.effects.has(agent.agentId)) return;
    const handle = this.agentLifecycle.get(agent);
    if (handle === undefined) {
      throw new Error(`Agent ${agent.agentId}:${String(agent.generation)} is stale`);
    }
    if (agent.agentId !== MAIN_AGENT_ID) return;
    const eventBus = handle.accessor.get(IEventBus);
    const injector = handle.accessor.get(IAgentContextInjectorService);
    const memory = handle.accessor.get(IAgentContextMemoryService);
    const toolPolicy = handle.accessor.get(IAgentToolPolicyService);
    const runtime = TodoAgentEffectDefinition.create({
      agent,
      getTodos: () => agentSpaceOf(agent).use(TodoAgentModelDefinition, (model) => model.items()),
      getHistory: () => memory.get(),
      isToolActive: () => toolPolicy.isToolActive(TODO_LIST_TOOL_NAME, 'builtin'),
      registerReminder: (provider) => injector.register(TODO_LIST_REMINDER_VARIANT, provider),
      subscribeChange: (listener) =>
        this.onDidChange((change) => {
          if (change.agent === agent) listener(change.todos);
        }),
      subscribeUndo: (listener) => eventBus.subscribe(ContextUndone, listener),
      onChange: (todos) => {
        this.fireChange(agent, todos);
      },
    });
    this.effects.set(agent.agentId, runtime);
  }

  private disposeEffect(agentId: string): void {
    const effect = this.effects.get(agentId);
    if (effect === undefined) return;
    this.effects.delete(agentId);
    try {
      const result = effect.dispose();
      if (result instanceof Promise) {
        result.catch((error: unknown) => onUnexpectedError(error));
      }
    } catch (error) {
      onUnexpectedError(error);
    }
  }

  private fireChange(agent: AgentContext, todos: readonly TodoItem[]): void {
    this.onDidChangeEmitter.fire({ agent, todos });
  }
}
