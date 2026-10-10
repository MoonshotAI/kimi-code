import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import {
  _clearScopedRegistryForTests,
  ScopeActivation,
  registerScopedService,
  type IAgentScopeHandle,
  type Scope,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { IEventBus } from '#/app/event/eventBus';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { OrderedHookSlot } from '#/hooks';
import type { Event2, Event2Class } from '#/app/event/event2';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded, turnKey } from '#/agent/loop/turnOps';
import { IAgentTaskService } from '#/agent/task/task';
import { TaskStarted, TaskTerminatedNotice } from '#/agent/task/taskOps';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { ToolCallStarted, ToolResultEvent } from '#/agent/toolExecutor/toolExecutorEvents';
import {
  NOTIFY_USER_DELIVERED_OUTPUT,
  NOTIFY_USER_SUPPRESSED_OUTPUT,
  NOTIFY_USER_TOOL_NAME,
} from '#/features/notify/tools/notify-user/notify-user';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { SubagentSpawned } from '#/session/subagent/mirrorAgentRun';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { interactions } from '#/human/interaction/facade';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionActivityView,
  type SessionActivityChangedEvent,
} from '#/session/sessionActivity/sessionActivity';
import { SessionActivityView } from '#/session/sessionActivity/sessionActivityService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';
import { stubAgentContext } from '../../agent/agentContext/stubs';

const SESSION_ID = 'session-a';

class FakeBus implements IEventBus {
  declare readonly _serviceBrand: undefined;
  private readonly handlers = new Set<{ type?: string; fn: (event: Event2) => void }>();

  publish(event: Event2): void {
    for (const h of [...this.handlers]) {
      if (h.type === undefined || h.type === event.type) h.fn(event);
    }
  }

  subscribe(arg1: unknown, arg2?: unknown): IDisposable {
    const entry =
      typeof arg1 === 'string'
        ? { type: arg1, fn: arg2 as (event: Event2) => void }
        : typeof arg1 === 'function' && 'type' in arg1
          ? { type: (arg1 as Event2Class).type, fn: arg2 as (event: Event2) => void }
          : { fn: arg1 as (event: Event2) => void };
    this.handlers.add(entry);
    return { dispose: () => this.handlers.delete(entry) };
  }
}

class FakeAgentHandle {
  readonly kind = LifecycleScope.Agent;
  readonly bus = new FakeBus();
  readonly state = new AgentStateService();
  readonly restoreSlot = new OrderedHookSlot<Record<string, never>>();
  loopState: 'idle' | 'running' = 'idle';
  activeTasks: string[] = [];
  compactingValue: unknown = null;
  readonly context: AgentContext;
  readonly accessor;

  constructor(readonly id: string) {
    this.context = stubAgentContext(id, 1);
    this.accessor = {
      get: (token: unknown) => {
        if (token === IEventBus) return this.bus;
        if (token === IEventDispatcher) return { hooks: { onDidRestore: this.restoreSlot } };
        if (token === IAgentLoopService) {
          return { snapshot: () => ({ state: this.loopState }) };
        }
        if (token === IAgentTaskService) {
          return { list: () => this.activeTasks.map((taskId) => ({ taskId })) };
        }
        if (token === IAgentFullCompactionService) {
          return { compacting: this.compactingValue };
        }
        if (token === IAgentStateService) return this.state;
        return undefined;
      },
    };
  }

  startTurn(turnId: number): void {
    this.loopState = 'running';
    this.bus.publish(new TurnStarted({ agentId: this.id, turnId, origin: { kind: 'user' } }));
  }

  endTurn(turnId: number, reason: 'completed' | 'cancelled' | 'failed' | 'blocked'): void {
    this.loopState = 'idle';
    this.bus.publish(new TurnEnded({ agentId: this.id, turnId, reason }));
  }

  startTask(taskId: string): void {
    this.activeTasks.push(taskId);
    this.bus.publish(
      new TaskStarted({
        agentId: this.id,
        info: {
          taskId,
          description: taskId,
          status: 'running',
          startedAt: Date.now(),
          endedAt: null,
          kind: 'process',
          command: taskId,
          pid: 0,
          exitCode: null,
        },
      }),
    );
  }

  terminateTask(taskId: string): void {
    this.activeTasks = this.activeTasks.filter((id) => id !== taskId);
    this.bus.publish(
      new TaskTerminatedNotice({
        agentId: this.id,
        info: {
          taskId,
          description: taskId,
          status: 'completed',
          startedAt: Date.now(),
          endedAt: Date.now(),
          kind: 'process',
          command: taskId,
          pid: 0,
          exitCode: null,
        },
      }),
    );
  }

  async runRestore(): Promise<void> {
    await this.restoreSlot.run({});
  }

  callTool(toolCallId: string, name: string, args: unknown): void {
    this.bus.publish(new ToolCallStarted({ agentId: this.id, turnId: 1, toolCallId, name, args }));
  }

  finishTool(
    toolCallId: string,
    output: unknown,
    extra: { readonly isError?: boolean; readonly synthetic?: boolean } = {},
  ): void {
    this.bus.publish(new ToolResultEvent({ agentId: this.id, turnId: 1, toolCallId, output, ...extra }));
  }

  notify(toolCallId: string, title: string): void {
    this.callTool(toolCallId, NOTIFY_USER_TOOL_NAME, { title, message: `${title} details` });
    this.finishTool(toolCallId, NOTIFY_USER_DELIVERED_OUTPUT);
  }

  spawn(subagentId: string, description?: string): void {
    this.bus.publish(
      new SubagentSpawned({
        subagentId,
        subagentName: 'explore',
        parentToolCallId: `call-${subagentId}`,
        description,
        runInBackground: false,
      }),
    );
  }

  dispose(): void {}
}

class FakeAgentLifecycle implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly createEmitter = new Emitter<AgentContext>();
  private readonly createScopeEmitter = new Emitter<{
    readonly context: AgentContext;
    readonly handle: IAgentScopeHandle;
  }>();
  private readonly willCloseEmitter = new Emitter<AgentContext>();
  private readonly didCloseEmitter = new Emitter<AgentContext>();
  readonly onDidCreate = this.createEmitter.event;
  readonly onDidCreateScope = this.createScopeEmitter.event;
  readonly onWillClose = this.willCloseEmitter.event;
  readonly onDidClose = this.didCloseEmitter.event;
  readonly handles: FakeAgentHandle[] = [];

  list(): readonly AgentContext[] {
    return this.handles.map((handle) => handle.context);
  }

  get(agentId: string): AgentContext | undefined {
    return this.handles.find((h) => h.id === agentId)?.context;
  }

  handleOf(agentId: string): IAgentScopeHandle | undefined {
    return this.handles.find((h) => h.id === agentId) as IAgentScopeHandle | undefined;
  }

  addAgent(id: string): FakeAgentHandle {
    const handle = new FakeAgentHandle(id);
    this.handles.push(handle);
    const scopeHandle = handle as unknown as IAgentScopeHandle;
    this.createEmitter.fire(handle.context);
    this.createScopeEmitter.fire({ context: handle.context, handle: scopeHandle });
    return handle;
  }

  removeAgent(id: string): void {
    const index = this.handles.findIndex((h) => h.id === id);
    if (index < 0) return;
    const [handle] = this.handles.splice(index, 1);
    this.willCloseEmitter.fire(handle!.context);
    this.didCloseEmitter.fire(handle!.context);
  }

  create(): Promise<AgentContext> {
    throw new Error('not implemented');
  }
  fork(): Promise<AgentContext> {
    throw new Error('not implemented');
  }
  remove(): Promise<void> {
    throw new Error('not implemented');
  }
  broadcastPermissionMode(): void {
    throw new Error('not implemented');
  }
  adopt(): AgentContext {
    throw new Error('not implemented');
  }
}

describe('ISessionActivityView (Session scope aggregate of agent activity + interactions)', () => {
  let disposables: DisposableStore;
  let host: ScopedTestHost;
  let session: Scope;
  let lifecycle: FakeAgentLifecycle;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.Session, ISessionStateService, SessionStateService, ScopeActivation.OnScopeCreated, 'state');
    registerScopedService(LifecycleScope.Session, IAgentLifecycleService, FakeAgentLifecycle, ScopeActivation.OnDemand, 'agentLifecycle');
    registerScopedService(LifecycleScope.Session, ISessionActivityView, SessionActivityView, ScopeActivation.OnScopeCreated, 'sessionActivity');

    disposables = new DisposableStore();
    host = createScopedTestHost();
    session = host.child(LifecycleScope.Session, SESSION_ID, [
      stubPair(IWorkspaceStateService, new WorkspaceStateService()),
      stubPair(ISessionContext, { sessionId: SESSION_ID } as ISessionContext),
    ]);
    lifecycle = session.accessor.get(IAgentLifecycleService) as unknown as FakeAgentLifecycle;
  });

  afterEach(() => {
    disposables.dispose();
    host.dispose();
    interactions.purgeSession(SESSION_ID);
  });

  function viewWithChanges(): {
    view: ISessionActivityView;
    changes: SessionActivityChangedEvent[];
  } {
    const changes: SessionActivityChangedEvent[] = [];
    const view = session.accessor.get(ISessionActivityView);
    disposables.add(view.onDidChange((change) => changes.push(change)));
    return { view, changes };
  }

  it('starts idle when no agent has work', () => {
    lifecycle.addAgent(MAIN_AGENT_ID);
    const { view } = viewWithChanges();
    expect(view.state()).toEqual({
      busy: false,
      mainTurnActive: false,
      pendingInteraction: 'none',
      lastTurnReason: undefined,
    });
  });

  it('seeds the aggregate from agents already active at construction', () => {
    const seededLifecycle = new FakeAgentLifecycle();
    const main = seededLifecycle.addAgent(MAIN_AGENT_ID);
    main.loopState = 'running';
    const seededSession = host.child(LifecycleScope.Session, 'session-seeded', [
      stubPair(IAgentLifecycleService, seededLifecycle),
      stubPair(IWorkspaceStateService, new WorkspaceStateService()),
      stubPair(ISessionContext, { sessionId: 'session-seeded' } as ISessionContext),
    ]);
    const view = seededSession.accessor.get(ISessionActivityView);
    expect(view.state().busy).toBe(true);
    expect(view.state().mainTurnActive).toBe(true);
  });

  it('fires turn_started when the main agent begins a turn', () => {
    const main = lifecycle.addAgent(MAIN_AGENT_ID);
    const { changes } = viewWithChanges();

    main.startTurn(1);

    expect(changes).toEqual([
      {
        state: { busy: true, mainTurnActive: true, pendingInteraction: 'none', lastTurnReason: undefined },
        cause: 'turn_started',
      },
    ]);
  });

  it('fires turn_ended with the mapped outcome when the main agent ends a turn', () => {
    const main = lifecycle.addAgent(MAIN_AGENT_ID);
    const { changes } = viewWithChanges();

    main.startTurn(1);
    main.endTurn(1, 'completed');

    expect(changes.at(-1)).toEqual({
      state: { busy: false, mainTurnActive: false, pendingInteraction: 'none', lastTurnReason: 'completed' },
      cause: 'turn_ended',
    });

    main.startTurn(2);
    main.endTurn(2, 'blocked');

    expect(changes.at(-1)?.state.lastTurnReason).toBe('failed');
  });

  it('tracks subagent turns in busy without touching the main-agent slices', () => {
    const sub = lifecycle.addAgent('agent-0');
    const { view, changes } = viewWithChanges();

    sub.startTurn(1);

    expect(view.state().busy).toBe(true);
    expect(view.state().mainTurnActive).toBe(false);
    expect(view.state().lastTurnReason).toBeUndefined();

    sub.endTurn(1, 'completed');

    expect(changes).toHaveLength(2);
    expect(view.state().busy).toBe(false);
    expect(view.state().lastTurnReason).toBeUndefined();
  });

  it('fires background when live background work changes without a turn', () => {
    const main = lifecycle.addAgent(MAIN_AGENT_ID);
    const { view, changes } = viewWithChanges();

    main.startTask('t1');

    expect(changes).toEqual([
      {
        state: { busy: true, mainTurnActive: false, pendingInteraction: 'none', lastTurnReason: undefined },
        cause: 'background',
      },
    ]);

    main.terminateTask('ghost');
    expect(changes).toHaveLength(1);

    main.terminateTask('t1');
    expect(view.state().busy).toBe(false);
  });

  it('re-seeds from restored agent state when restore completes', async () => {
    const main = lifecycle.addAgent(MAIN_AGENT_ID);
    const { view, changes } = viewWithChanges();

    main.activeTasks.push('t-restored');
    main.state.contributeState(turnKey);
    main.state.set(turnKey, {
      nextTurnId: 1,
      cancelledTurnIds: [],
      anchorTurnIds: [],
      lastEnded: { turnId: 0, reason: 'completed' },
    });
    await main.runRestore();

    expect(view.state()).toEqual({
      busy: true,
      mainTurnActive: false,
      pendingInteraction: 'none',
      lastTurnReason: 'completed',
    });
    expect(changes.at(-1)?.cause).toBe('agent_lifecycle');
  });

  it('does not fire when the aggregate is unchanged (phase churn inside a turn)', () => {
    const main = lifecycle.addAgent(MAIN_AGENT_ID);
    const { changes } = viewWithChanges();

    main.startTurn(1);
    main.startTurn(1);

    expect(changes).toHaveLength(1);
  });

  it('fires interaction when the pending set flips the session slice', () => {
    lifecycle.addAgent(MAIN_AGENT_ID);
    const { changes } = viewWithChanges();

    interactions.enqueue({ id: 'a1', kind: 'approval', payload: {}, tags: { agentId: MAIN_AGENT_ID, sessionId: SESSION_ID } });
    expect(changes.at(-1)).toEqual({
      state: { busy: false, mainTurnActive: false, pendingInteraction: 'approval', lastTurnReason: undefined },
      cause: 'interaction',
    });

    interactions.enqueue({ id: 'q1', kind: 'question', payload: {}, tags: { agentId: MAIN_AGENT_ID, sessionId: SESSION_ID } });
    expect(changes).toHaveLength(1);

    interactions.respond('a1', { approved: true });
    expect(changes.at(-1)?.state.pendingInteraction).toBe('question');
  });

  it('treats user_tool pending as none', () => {
    lifecycle.addAgent(MAIN_AGENT_ID);
    const { changes } = viewWithChanges();

    interactions.enqueue({ id: 'u1', kind: 'user_tool', payload: {}, tags: { agentId: MAIN_AGENT_ID, sessionId: SESSION_ID } });
    expect(changes).toHaveLength(0);
  });

  it('drops a disposed agent from the aggregate with agent_lifecycle cause', () => {
    const sub = lifecycle.addAgent('agent-0');
    const { view, changes } = viewWithChanges();

    sub.startTurn(1);
    expect(view.state().busy).toBe(true);

    lifecycle.removeAgent('agent-0');
    expect(changes.at(-1)).toEqual({
      state: { busy: false, mainTurnActive: false, pendingInteraction: 'none', lastTurnReason: undefined },
      cause: 'agent_lifecycle',
    });
  });

  it('seeds agents created after construction through onDidCreate', () => {
    const { view, changes } = viewWithChanges();

    const sub = lifecycle.addAgent('agent-0');
    sub.startTurn(1);

    expect(view.state().busy).toBe(true);
    expect(changes.at(-1)?.cause).toBe('turn_started');
  });
  describe('latest NotifyUser update', () => {
    it('records the main agent update once the tool result confirms it was shown', () => {
      const main = lifecycle.addAgent(MAIN_AGENT_ID);
      const { view, changes } = viewWithChanges();
      main.startTurn(1);

      main.callTool('call-1', NOTIFY_USER_TOOL_NAME, { title: '  Plan ready  ', message: 'Three steps.' });
      expect(view.state().latestUpdate).toBeUndefined();
      main.finishTool('call-1', NOTIFY_USER_DELIVERED_OUTPUT);

      expect(changes.at(-1)?.cause).toBe('update');
      expect(view.state().latestUpdate).toEqual({
        title: 'Plan ready',
        agentId: MAIN_AGENT_ID,
        source: undefined,
        at: expect.any(String),
      });
      expect(Number.isNaN(Date.parse(view.state().latestUpdate!.at))).toBe(false);
    });

    it('labels a subagent update with the description it was spawned with', () => {
      const main = lifecycle.addAgent(MAIN_AGENT_ID);
      const sub = lifecycle.addAgent('agent-1');
      const { view } = viewWithChanges();
      main.startTurn(1);
      main.spawn('agent-1', '  Audit refresh paths ');
      sub.startTurn(1);

      sub.notify('call-1', 'Found two refresh paths');

      expect(view.state().latestUpdate).toMatchObject({
        title: 'Found two refresh paths',
        agentId: 'agent-1',
        source: 'Audit refresh paths',
      });

      main.notify('call-2', 'Root cause found');
      expect(view.state().latestUpdate).toMatchObject({
        title: 'Root cause found',
        agentId: MAIN_AGENT_ID,
        source: undefined,
      });
    });

    it('ignores other tools and updates that failed, were synthetic, or were not shown', () => {
      const main = lifecycle.addAgent(MAIN_AGENT_ID);
      const { view, changes } = viewWithChanges();
      main.startTurn(1);
      const before = changes.length;

      main.callTool('call-1', 'Bash', { title: 'not an update', command: 'ls' });
      main.finishTool('call-1', NOTIFY_USER_DELIVERED_OUTPUT);
      main.callTool('call-2', NOTIFY_USER_TOOL_NAME, { title: 'Errored', message: 'x' });
      main.finishTool('call-2', 'boom', { isError: true });
      main.callTool('call-3', NOTIFY_USER_TOOL_NAME, { title: 'Synthetic', message: 'x' });
      main.finishTool('call-3', NOTIFY_USER_DELIVERED_OUTPUT, { synthetic: true });
      main.callTool('call-4', NOTIFY_USER_TOOL_NAME, { title: 'Suppressed', message: 'x' });
      main.finishTool('call-4', NOTIFY_USER_SUPPRESSED_OUTPUT);
      main.callTool('call-5', NOTIFY_USER_TOOL_NAME, { title: '   ', message: 'x' });
      main.finishTool('call-5', NOTIFY_USER_DELIVERED_OUTPUT);

      expect(view.state().latestUpdate).toBeUndefined();
      expect(changes).toHaveLength(before);
    });

    it('drops a pending update when its agent turn ends before the result', () => {
      const main = lifecycle.addAgent(MAIN_AGENT_ID);
      const sub = lifecycle.addAgent('agent-1');
      const { view } = viewWithChanges();
      main.startTurn(1);
      sub.startTurn(1);

      sub.callTool('call-1', NOTIFY_USER_TOOL_NAME, { title: 'Interrupted', message: 'x' });
      sub.endTurn(1, 'cancelled');
      sub.finishTool('call-1', NOTIFY_USER_DELIVERED_OUTPUT);

      expect(view.state().latestUpdate).toBeUndefined();
    });

    it('clears the update in the same change that reports the session going idle', () => {
      const main = lifecycle.addAgent(MAIN_AGENT_ID);
      const { view, changes } = viewWithChanges();
      main.startTurn(1);
      main.notify('call-1', 'Tests pass');

      main.endTurn(1, 'completed');

      expect(changes.at(-1)).toEqual({
        state: {
          busy: false,
          mainTurnActive: false,
          pendingInteraction: 'none',
          lastTurnReason: 'completed',
          latestUpdate: undefined,
        },
        cause: 'turn_ended',
      });
      main.startTask('t1');
      expect(view.state().busy).toBe(true);
      expect(view.state().latestUpdate).toBeUndefined();
    });

    it('keeps a background subagent update after the main turn ends while the session stays busy', () => {
      const main = lifecycle.addAgent(MAIN_AGENT_ID);
      const sub = lifecycle.addAgent('agent-1');
      const { view } = viewWithChanges();
      main.startTurn(1);
      main.spawn('agent-1', 'Watch the build');
      sub.startTurn(1);
      main.endTurn(1, 'completed');

      sub.notify('call-1', 'Build is halfway');

      expect(view.state().mainTurnActive).toBe(false);
      expect(view.state().latestUpdate).toMatchObject({ title: 'Build is halfway', source: 'Watch the build' });
    });

    it('clears the previous update when the main agent starts a new turn', () => {
      const main = lifecycle.addAgent(MAIN_AGENT_ID);
      const sub = lifecycle.addAgent('agent-1');
      const { view, changes } = viewWithChanges();
      main.startTurn(1);
      sub.startTurn(1);
      main.notify('call-1', 'Old update');
      main.endTurn(1, 'completed');
      expect(view.state().latestUpdate).toMatchObject({ title: 'Old update' });

      main.startTurn(2);

      expect(view.state().latestUpdate).toBeUndefined();
      expect(changes.at(-1)?.cause).toBe('turn_started');
    });
  });
});
