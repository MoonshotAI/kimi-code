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

import type {
  AgentEventMessage,
  AgentFeedMessage,
  GoalEventMessage,
  GoalState,
  TodoEventMessage,
  UsageEventMessage,
  UsageState,
} from '../../../protocol/ws-agent';
import {
  optionalService,
  readAgentState,
  readGoalState,
  readTodoItems,
  readUsageState,
} from './agentState';

export const USAGE_FRAME_INTERVAL_MS = 250;

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
    private readonly usageIntervalMs = USAGE_FRAME_INTERVAL_MS,
  ) {
    for (const agent of agents.list()) this.watch(agent.agentId, false);
    this.lifecycleWatches = [
      agents.onDidCreate((agent) => {
        this.watch(agent.agentId, true);
      }),
      agents.onDidClose((agent) => {
        this.unwatch(agent.agentId);
      }),
    ];
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
      new AgentWatch(this.sessionId, agentId, handle, this.send, this.usageIntervalMs, announce),
    );
  }

  private unwatch(agentId: string): void {
    this.watches.get(agentId)?.dispose();
    this.watches.delete(agentId);
  }
}

class AgentWatch implements IDisposable {
  private running: boolean;
  private flushQueued = false;
  private disposed = false;
  private lastAgent?: string;
  private lastGoal?: string;
  private lastTodo?: string;
  private lastUsage?: string;
  private pendingUsage?: UsageState;
  private usageTimer?: ReturnType<typeof setTimeout>;
  private readonly subscriptions: IDisposable[] = [];

  constructor(
    private readonly sessionId: string,
    private readonly agentId: string,
    private readonly handle: IAgentScopeHandle,
    private readonly send: AgentFeedSend,
    private readonly usageIntervalMs: number,
    announce: boolean,
  ) {
    this.running = loopRunning(handle);
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
    const usage = readUsageState(this.handle);
    if (usage !== undefined) messages.push(this.usageMessage(usage));
    if (this.agentId === MAIN_AGENT_ID) messages.push(this.goalMessage(readGoalState(this.handle)));
    messages.push(this.todoMessage());
    return messages;
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    if (this.usageTimer !== undefined) clearTimeout(this.usageTimer);
    this.usageTimer = undefined;
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
    const usage = readUsageState(this.handle);
    this.lastUsage = usage === undefined ? undefined : JSON.stringify(usage);
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

    const usage = readUsageState(this.handle);
    if (usage === undefined) return;
    const nextUsage = JSON.stringify(usage);
    if (nextUsage === this.lastUsage) return;
    this.lastUsage = nextUsage;
    this.pendingUsage = usage;
    if (this.usageTimer !== undefined) return;
    this.usageTimer = setTimeout(() => {
      this.usageTimer = undefined;
      const pending = this.pendingUsage;
      this.pendingUsage = undefined;
      if (pending !== undefined && !this.disposed) this.send(this.agentId, this.usageMessage(pending));
    }, this.usageIntervalMs);
    this.usageTimer.unref?.();
  }

  private agentMessage(): AgentEventMessage {
    return {
      type: 'agent',
      ...this.frameFields(),
      ...readAgentState(this.handle, this.running),
    };
  }

  private usageMessage(usage: UsageState): UsageEventMessage {
    return { type: 'usage', ...this.frameFields(), ...usage };
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
