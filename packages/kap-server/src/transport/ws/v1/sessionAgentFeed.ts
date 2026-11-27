import {
  IAgentLoopService,
  IAgentTodoService,
  IEventBus,
  MAIN_AGENT_ID,
  type Event2,
  type IAgentLifecycleService,
  type IAgentScopeHandle,
  type IDisposable,
} from '@moonshot-ai/agent-core-v2';
import { Event } from '@moonshot-ai/agent-core-v2/_base/event';

import type {
  AgentEventMessage,
  AgentFeedMessage,
  AgentState,
  ContextEventMessage,
  ContextState,
  GoalEventMessage,
  GoalState,
  TodoEventMessage,
} from '../../../protocol/ws-agent';
import {
  optionalService,
  readAgentState,
  readContextState,
  readGoalState,
  readTodoItems,
} from './agentState';

export const CONTEXT_FRAME_INTERVAL_MS = 250;
export const USAGE_FRAME_INTERVAL_MS = CONTEXT_FRAME_INTERVAL_MS;

const STATE_EVENT_TYPES = [
  'turn.started',
  'turn.ended',
  'compaction.started',
  'compaction.completed',
  'compaction.cancelled',
  'compaction.blocked',
  'agent.status.updated',
  'goal.updated',
] as const;

export type AgentFeedSend = (agentId: string, message: AgentFeedMessage) => void;

export class SessionAgentFeed implements IDisposable {
  private readonly watches = new Map<string, AgentWatch>();
  private readonly lifecycleWatches: readonly IDisposable[];

  constructor(
    private readonly sessionId: string,
    private readonly agents: IAgentLifecycleService,
    private readonly send: AgentFeedSend,
    onDidPolicyChange: Event<void> = Event.None as Event<void>,
    private readonly contextIntervalMs = CONTEXT_FRAME_INTERVAL_MS,
  ) {
    for (const agent of agents.list()) this.watch(agent.agentId, false);
    this.lifecycleWatches = [
      agents.onDidCreate((agent) => {
        this.watch(agent.agentId, true);
      }),
      agents.onWillClose((agent) => {
        this.watches.get(agent.agentId)?.captureBeforeClose();
      }),
      agents.onDidClose((agent) => {
        this.close(agent.agentId);
      }),
      onDidPolicyChange(() => {
        this.refresh();
      }),
    ];
  }

  refresh(): void {
    for (const watch of this.watches.values()) watch.refresh();
  }

  agentIds(): readonly string[] {
    return [...this.watches.keys()];
  }

  snapshot(agentId: string): AgentFeedMessage[] {
    return this.watches.get(agentId)?.snapshot() ?? [];
  }

  dispose(): void {
    for (const watch of this.lifecycleWatches) watch.dispose();
    for (const watch of this.watches.values()) watch.dispose();
    this.watches.clear();
  }

  private watch(agentId: string, announce: boolean): void {
    if (this.watches.has(agentId)) return;
    const handle = this.agents.handleOf(agentId);
    if (handle === undefined) return;
    this.watches.set(
      agentId,
      new AgentWatch(this.sessionId, agentId, handle, this.send, this.contextIntervalMs, announce),
    );
  }

  private close(agentId: string): void {
    const watch = this.watches.get(agentId);
    if (watch === undefined) return;
    this.watches.delete(agentId);
    watch.close();
  }
}

class AgentWatch implements IDisposable {
  private running: boolean;
  private flushQueued = false;
  private disposed = false;
  private lastState: AgentState;
  private lastAgent?: string;
  private lastGoal?: string;
  private lastTodo?: string;
  private lastContext?: string;
  private pendingContext?: ContextState;
  private contextTimer?: ReturnType<typeof setTimeout>;
  private readonly subscriptions: IDisposable[] = [];

  constructor(
    private readonly sessionId: string,
    private readonly agentId: string,
    private readonly handle: IAgentScopeHandle,
    private readonly send: AgentFeedSend,
    private readonly contextIntervalMs: number,
    announce: boolean,
  ) {
    this.running = loopRunning(handle);
    this.lastState = readAgentState(handle, this.running);
    const bus = optionalService(handle, IEventBus);
    if (bus !== undefined) {
      for (const type of STATE_EVENT_TYPES) {
        this.subscriptions.push(
          bus.subscribe(type, (event) => {
            this.onEvent(event);
          }),
        );
      }
    }
    const todo = optionalService(handle, IAgentTodoService);
    if (todo !== undefined) {
      this.subscriptions.push(
        todo.onDidChange(() => {
          this.schedule();
        }),
      );
    }
    if (announce) this.schedule();
    else this.prime();
  }

  snapshot(): AgentFeedMessage[] {
    const messages: AgentFeedMessage[] = [this.agentMessage()];
    const context = readContextState(this.handle);
    if (context !== undefined) messages.push(this.contextMessage(context));
    if (this.agentId === MAIN_AGENT_ID) messages.push(this.goalMessage(readGoalState(this.handle)));
    messages.push(this.todoMessage());
    return messages;
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    if (this.contextTimer !== undefined) clearTimeout(this.contextTimer);
    this.contextTimer = undefined;
  }

  captureBeforeClose(): void {
    if (this.disposed) return;
    this.lastState = readAgentState(this.handle, false);
  }

  refresh(): void {
    this.schedule();
  }

  close(): void {
    this.dispose();
    this.send(this.agentId, {
      type: 'agent',
      ...this.frameFields(),
      ...this.lastState,
      status: 'ended',
      compacting: false,
    });
  }

  private onEvent(event: Event2<unknown>): void {
    if (event.type === 'turn.started') this.running = true;
    else if (event.type === 'turn.ended') this.running = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.flushQueued || this.disposed) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      if (!this.disposed) this.flush();
    });
  }

  private prime(): void {
    this.lastAgent = agentKey(this.agentMessage());
    if (this.agentId === MAIN_AGENT_ID) this.lastGoal = goalKey(readGoalState(this.handle));
    this.lastTodo = todoKey(this.todoMessage());
    const context = readContextState(this.handle);
    this.lastContext = context === undefined ? undefined : JSON.stringify(context);
  }

  private flush(): void {
    const agent = this.agentMessage();
    const nextAgent = agentKey(agent);
    if (nextAgent !== this.lastAgent) {
      this.lastAgent = nextAgent;
      this.send(this.agentId, agent);
    }

    if (this.agentId === MAIN_AGENT_ID) {
      const goal = readGoalState(this.handle);
      const nextGoal = goalKey(goal);
      if (nextGoal !== this.lastGoal) {
        this.lastGoal = nextGoal;
        this.send(this.agentId, this.goalMessage(goal));
      }
    }

    const todo = this.todoMessage();
    const nextTodo = todoKey(todo);
    if (nextTodo !== this.lastTodo) {
      this.lastTodo = nextTodo;
      this.send(this.agentId, todo);
    }

    const context = readContextState(this.handle);
    if (context === undefined) return;
    const nextContext = JSON.stringify(context);
    if (nextContext === this.lastContext) return;
    this.lastContext = nextContext;
    this.pendingContext = context;
    if (this.contextTimer !== undefined) return;
    this.contextTimer = setTimeout(() => {
      this.contextTimer = undefined;
      const pending = this.pendingContext;
      this.pendingContext = undefined;
      if (pending !== undefined && !this.disposed) {
        this.send(this.agentId, this.contextMessage(pending));
      }
    }, this.contextIntervalMs);
    this.contextTimer.unref?.();
  }

  private agentMessage(): AgentEventMessage {
    this.lastState = readAgentState(this.handle, this.running);
    return {
      type: 'agent',
      ...this.frameFields(),
      ...this.lastState,
    };
  }

  private contextMessage(context: ContextState): ContextEventMessage {
    return { type: 'context', ...this.frameFields(), ...context };
  }

  private goalMessage(goal: GoalState | undefined): GoalEventMessage {
    return { type: 'goal', ...this.frameFields(), goal };
  }

  private todoMessage(): TodoEventMessage {
    return { type: 'todo', ...this.frameFields(), items: readTodoItems(this.handle) };
  }

  private frameFields(): { session_id: string; agent_id: string; event_created_at: string } {
    return {
      session_id: this.sessionId,
      agent_id: this.agentId,
      event_created_at: new Date().toISOString(),
    };
  }
}

function agentKey(message: AgentEventMessage): string {
  return JSON.stringify({ ...message, event_created_at: undefined });
}

function goalKey(goal: GoalState | undefined): string {
  return goal === undefined ? '' : JSON.stringify({ ...goal, wall_clock_ms: undefined });
}

function todoKey(message: TodoEventMessage): string {
  return JSON.stringify(message.items);
}

function loopRunning(handle: IAgentScopeHandle): boolean {
  return optionalService(handle, IAgentLoopService)?.snapshot().state === 'running';
}
