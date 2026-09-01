import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { createReminderStub } from '../reminder/stubs';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { runWillBeginStepHooks, type StubLoop } from '../../agent/loop/stubs';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { TowerStore } from '#/features/tower/protocol/index';
import { IAgentTowerService, TOWER_FLAG_ID } from '#/features/tower/tower';
import { _setTowerFeatureAssembledForTests } from '#/features/tower/towerFeature';
import { AgentTowerService, TOWER_MODE_TOOLS } from '#/features/tower/towerService';
import { towerKey } from '#/features/tower/towerOps';
import { TaskTerminatedNotice } from '#/agent/task/taskOps';
import { SubagentStarted } from '#/session/subagent/mirrorAgentRun';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventBus, ISessionEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IConfigService } from '#/app/config/config';
import { IFeatureManager } from '#/app/feature/featureManager';
import { IFlagService } from '#/app/flag/flag';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import {
  ISessionActivityView,
  type SessionPendingInteraction,
} from '#/session/sessionActivity/sessionActivity';
import type { ToolCall } from '#/kosong/contract/message';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ToolAccesses } from '#/tool/toolContract';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../../agent/toolExecutor/stubs';
import { stubFlag } from '../../app/flag/stubs';
import {
  appService,
  createTestAgent,
  type TestAgentContext,
} from '../../harness';
import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

const execFileAsync = promisify(execFile);

async function initGitRepo(repo: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'tower-test@example.com'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'Tower Test'], { cwd: repo });
}

_setTowerFeatureAssembledForTests(true);

const signal = new AbortController().signal;

let mainAgentContext: ReturnType<typeof makeAgentScopeContext>['agentContext'];

function stubMainAgentScope(ix: TestInstantiationService): void {
  const agentScope = makeAgentScopeContext({
    agentId: 'main',
    agentScope: testWireScope('wire', 'tower-test'),
    generation: 0,
  });
  ix.stub(IAgentScopeContext, agentScope);
  mainAgentContext = agentScope.agentContext;
  const bus = ix.get(IEventBus) as ISessionEventBus;
  if (typeof bus.activateAgent === 'function') bus.activateAgent(agentScope.agentContext);
}

function publishAsMain(ix: TestInstantiationService, event: Parameters<IEventBus['publish']>[0]): void {
  ix.get(IEventBus).publish(event, mainAgentContext);
}

function toolCall(name: string, id: string): ToolCall {
  return { type: 'function', id, name, arguments: '{}' };
}

function hookContext(toolCalls: ToolCall[]): ResolvedToolExecutionHookContext {
  return {
    turnId: 0,
    signal,
    toolCall: toolCalls[0]!,
    toolCalls,
    args: {},
    execution: { approvalRule: toolCalls[0]!.name, execute: async () => ({ output: '' }) },
  };
}

function writeHookContext(toolName: string, paths: readonly string[]): ResolvedToolExecutionHookContext {
  const call = toolCall(toolName, `call_${toolName.toLowerCase()}`);
  return {
    turnId: 0,
    signal,
    toolCall: call,
    toolCalls: [call],
    args: {},
    execution: {
      approvalRule: toolName,
      accesses: paths.flatMap((path) => ToolAccesses.writeFile(path)),
      execute: async () => ({ output: '' }),
    },
  };
}

describe('AgentTowerService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let executorEvents: ToolExecutorEventStubs;
  let permissionGateRan: boolean;
  let formatDenyMessage: Mock<(message: string) => string>;
  let towerFlagOn: boolean;
  let addedTools: string[];
  let removedTools: string[];
  let activeTools: string[] | undefined;
  let liveSessions: Map<string, { busy: boolean; pendingInteraction: SessionPendingInteraction; exit: Mock<() => void> }>;
  let fireUnitsChanged: () => void = () => {};

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    executorEvents = stubToolExecutorEvents();
    permissionGateRan = false;
    ix.stub(IAgentToolExecutorService, executorEvents.executor);
    formatDenyMessage = vi.fn((message: string) => message);
    ix.stub(IAgentToolApprovalService, { formatDenyMessage });
    towerFlagOn = true;
    ix.stub(IFlagService, stubFlag((id) => towerFlagOn && id === TOWER_FLAG_ID));
    liveSessions = new Map();
    ix.stub(ISessionManager, {
      get: (id: string) => {
        const stub = liveSessions.get(id);
        if (stub === undefined) return undefined;
        return {
          accessor: {
            get: (token: unknown) => {
              if (token === (ISessionActivityView as unknown)) {
                return {
                  state: () => ({
                    busy: stub.busy,
                    mainTurnActive: stub.busy,
                    pendingInteraction: stub.pendingInteraction,
                  }),
                };
              }
              if (token === (IAgentLifecycleService as unknown)) {
                return {
                  handleOf: () => ({
                    accessor: {
                      get: (agentToken: unknown) =>
                        agentToken === (IAgentTowerService as unknown)
                          ? { exit: stub.exit }
                          : undefined,
                    },
                  }),
                };
              }
              return undefined;
            },
          },
        };
      },
    } as unknown as ISessionManager);
    ix.stub(IFeatureManager, {
      onDidChangeUnits: (handler: () => void) => {
        fireUnitsChanged = handler;
        return { dispose: () => {} };
      },
    } as unknown as IFeatureManager);
    addedTools = [];
    removedTools = [];
    activeTools = undefined;
    ix.stub(IAgentProfileService, {
      data: () => ({ profileName: undefined }),
      getActiveToolNames: () => activeTools,
      addActiveTool: (name: string) => {
        addedTools.push(name);
        activeTools = [...(activeTools ?? []), name];
      },
      removeActiveTool: (name: string) => {
        removedTools.push(name);
        activeTools = activeTools?.filter((candidate) => candidate !== name);
      },
    } as unknown as IAgentProfileService);
    ix.stub(
      IAgentReminderService,
      createReminderStub(),
    );
    ix.stub(IAgentContextMemoryService, {
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    ix.stub(ISessionContext, { cwd: '/nonexistent-tower-repo' } as unknown as ISessionContext);
    registerTestAgentWire(ix, testWireScope('wire', 'tower-test'), {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    stubMainAgentScope(ix);
    registerTestEventDispatcher(ix);
    ix.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
  });
  afterEach(() => disposables.dispose());

  async function fire(
    ctx: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    disposables.add(
      executorEvents.executor.onBeforeExecuteTool(() => {
        permissionGateRan = true;
      }),
    );
    return executorEvents.fireBeforeExecute(ctx);
  }

  it('enter / exit toggle isActive and emit agent.status.updated via wire', async () => {
    const tower = ix.get(IAgentTowerService);
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );

    expect(tower.isActive).toBe(false);
    await tower.enter();
    expect(tower.isActive).toBe(true);
    tower.exit();
    expect(tower.isActive).toBe(false);

    expect(events).toEqual([
      { type: 'agent.status.updated', towerMode: true },
      { type: 'agent.status.updated', towerMode: false },
    ]);
  });

  it('enter / exit are idempotent while already in that state', async () => {
    const tower = ix.get(IAgentTowerService);
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );

    tower.exit();
    expect(tower.isActive).toBe(false);
    await tower.enter();
    await tower.enter();
    expect(tower.isActive).toBe(true);

    expect(events).toEqual([{ type: 'agent.status.updated', towerMode: true }]);
  });

  it('enter(base) records the requested base; exit clears it', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-base-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await execFileAsync('git', ['branch', 'develop'], { cwd: repo });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-base' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      expect(tower.requestedBase).toBeUndefined();
      await tower.enter('develop');

      expect(tower.isActive).toBe(true);
      expect(tower.requestedBase).toBe('develop');
      const state = await new TowerStore(repo).load();
      expect(state.base).toBe('develop');
      expect(state.sessionId).toBe('session-base');

      tower.exit();
      expect(tower.requestedBase).toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter(base) creates the branch from HEAD, switches to it, and initializes the workspace on a fresh tower', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-create-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-create' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await tower.enter('integration');

      expect(tower.isActive).toBe(true);
      expect(tower.requestedBase).toBe('integration');
      const { stdout: checkout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
      expect(checkout.trim()).toBe('integration');
      const { stdout: branchTip } = await execFileAsync('git', ['rev-parse', 'integration'], { cwd: repo });
      const { stdout: mainTip } = await execFileAsync('git', ['rev-parse', 'main'], { cwd: repo });
      expect(branchTip).toBe(mainTip);
      const state = await new TowerStore(repo).load();
      expect(state.base).toBe('integration');
      expect(state.sessionId).toBe('session-create');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter(base) rejects an invalid branch name and does not activate', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-bad-base-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-base' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await expect(tower.enter('no..dots')).rejects.toThrow('git checkout -b no..dots failed');

      expect(tower.isActive).toBe(false);
      expect(tower.requestedBase).toBeUndefined();
      expect(addedTools).toEqual([]);
      expect(await new TowerStore(repo).isInitialized()).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter(base) rebases an already-initialized workspace when no missions are open', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-existing-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await execFileAsync('git', ['branch', 'develop'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init('session-previous', 'main');
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-next' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await tower.enter('develop');

      expect(tower.isActive).toBe(true);
      expect(tower.requestedBase).toBe('develop');
      const state = await store.load();
      expect(state.base).toBe('develop');
      const { stdout: checkout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
      expect(checkout.trim()).toBe('main');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter(base) creates the missing branch and rebases an already-initialized workspace', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-rebase-create-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init('session-previous', 'main');
      await writeFile(join(repo, 'README.md'), '# dirty wip\n');
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-next' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await tower.enter('add-new-feature');

      expect(tower.isActive).toBe(true);
      expect(tower.requestedBase).toBe('add-new-feature');
      const { stdout: checkout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
      expect(checkout.trim()).toBe('add-new-feature');
      const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
      expect(status.trim()).toBe('');
      const { stdout: wip } = await execFileAsync('git', ['show', 'add-new-feature:README.md'], { cwd: repo });
      expect(wip.trim()).toBe('# dirty wip');
      expect((await store.load()).base).toBe('add-new-feature');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter(base) refuses to rebase while missions are open and creates nothing', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-rebase-blocked-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init('session-previous', 'main');
      await store.plan([{ title: 'engine', scope: ['src/engine/**'] }]);
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-next' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await expect(tower.enter('add-new-feature')).rejects.toThrow('open mission(s)');

      expect(tower.isActive).toBe(false);
      expect(tower.requestedBase).toBeUndefined();
      const { stdout: branches } = await execFileAsync('git', ['branch', '--list', 'add-new-feature'], { cwd: repo });
      expect(branches.trim()).toBe('');
      expect((await store.load()).base).toBe('main');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter(base) on a dirty checkout commits the changes onto the new base and switches to it', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-dirty-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      const { stdout: mainTip } = await execFileAsync('git', ['rev-parse', 'main'], { cwd: repo });
      await writeFile(join(repo, 'README.md'), '# dirty wip\n');
      await writeFile(join(repo, 'wip-note.ts'), 'export const wip = 1;\n');
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-dirty' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await tower.enter('integration');

      expect(tower.isActive).toBe(true);
      const { stdout: checkout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
      expect(checkout.trim()).toBe('integration');
      const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
      expect(status.trim()).toBe('');
      const { stdout: wipReadme } = await execFileAsync('git', ['show', 'integration:README.md'], { cwd: repo });
      expect(wipReadme.trim()).toBe('# dirty wip');
      const { stdout: wipNew } = await execFileAsync('git', ['show', 'integration:wip-note.ts'], { cwd: repo });
      expect(wipNew).toContain('export const wip = 1;');
      const { stdout: mainTipAfter } = await execFileAsync('git', ['rev-parse', 'main'], { cwd: repo });
      expect(mainTipAfter).toBe(mainTip);
      const store = new TowerStore(repo);
      expect((await store.load()).base).toBe('integration');

      await store.plan([{ title: 'engine', scope: ['src/**'] }]);
      const mission = (await store.load()).missions[0]!;
      const added = await store.addWorktree(mission.worktree, mission.branch, 'integration');
      expect(added.spawnBase).toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter(base) refuses a checkout with unmerged paths', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-unmerged-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await execFileAsync('git', ['checkout', '-b', 'side'], { cwd: repo });
      await writeFile(join(repo, 'README.md'), '# side\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'side'], { cwd: repo });
      await execFileAsync('git', ['checkout', 'main'], { cwd: repo });
      await writeFile(join(repo, 'README.md'), '# main\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'main'], { cwd: repo });
      await execFileAsync('git', ['merge', 'side'], { cwd: repo }).catch(() => {});
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-unmerged' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await expect(tower.enter('integration')).rejects.toThrow('unmerged paths');

      expect(tower.isActive).toBe(false);
      expect(tower.requestedBase).toBeUndefined();
      const { stdout: branches } = await execFileAsync('git', ['branch', '--list', 'integration'], { cwd: repo });
      expect(branches.trim()).toBe('');
      expect(await new TowerStore(repo).isInitialized()).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('re-enter while active updates only the requested base', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-rebase-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await execFileAsync('git', ['branch', 'develop'], { cwd: repo });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-base' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);
      const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
      disposables.add(
        ix.get(IEventBus).subscribe((e) => {
          if (e.type === 'agent.status.updated') {
            events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
          }
        }),
      );

      await tower.enter();
      expect(tower.requestedBase).toBeUndefined();

      await tower.enter('develop');
      expect(tower.isActive).toBe(true);
      expect(tower.requestedBase).toBe('develop');

      await tower.enter('develop');
      await tower.enter();
      expect(tower.requestedBase).toBe('develop');

      expect(events).toEqual([
        { type: 'agent.status.updated', towerMode: true },
        { type: 'agent.status.updated', towerMode: true },
      ]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('records a tower worker death into the tower protocol on task termination', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-death-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init('session-main');
      await store.registerAgent({
        name: 'w1',
        kind: 'worker',
        agentId: 'agent-w1',
        sessionId: 'session-main',
        missionId: 'M1',
        spawnedAt: new Date().toISOString(),
      });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-main' } as unknown as ISessionContext);
      ix.get(IAgentTowerService);

      publishAsMain(
        ix,
        new TaskTerminatedNotice({
          agentId: 'main',
          info: {
            taskId: 'agent-dead1',
            kind: 'agent',
            description: 'tower worker w1: engine',
            status: 'failed',
            stopReason: 'provider blew up',
            startedAt: 1,
            endedAt: 2,
            agentId: 'agent-w1',
            subagentType: 'tower-worker',
          },
        }),
      );

      await vi.waitFor(async () => {
        const state = await store.load();
        expect(state.roster.agents[0]?.deathStatus).toBe('failed');
      });
      const state = await store.load();
      expect(state.roster.agents[0]?.diedAt).toBeDefined();
      expect(state.roster.agents[0]?.deathReason).toBe('provider blew up');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('ignores completions and non-roster agents when recording deaths', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-death-skip-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init('session-main');
      await store.registerAgent({
        name: 'w1',
        kind: 'worker',
        agentId: 'agent-w1',
        sessionId: 'session-main',
        spawnedAt: new Date().toISOString(),
      });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-main' } as unknown as ISessionContext);
      ix.get(IAgentTowerService);

      const info = {
        taskId: 'agent-fine1',
        kind: 'agent' as const,
        description: 'tower worker w1: engine',
        startedAt: 1,
        endedAt: 2,
        agentId: 'agent-w1',
        subagentType: 'tower-worker',
      };
      let deathSettled = Promise.resolve();
      const originalMarkDied = TowerStore.prototype.markAgentDied;
      const markSpy = vi
        .spyOn(TowerStore.prototype, 'markAgentDied')
        .mockImplementation(function (this: TowerStore, agentId, status, reason) {
          const pending = originalMarkDied.call(this, agentId, status, reason);
          deathSettled = pending.then(
            () => undefined,
            () => undefined,
          );
          return pending;
        });
      try {
        publishAsMain(
          ix,
          new TaskTerminatedNotice({ agentId: 'main', info: { ...info, status: 'completed' } }),
        );
        publishAsMain(
          ix,
          new TaskTerminatedNotice({
            agentId: 'main',
            info: { ...info, agentId: 'agent-stranger', status: 'failed' },
          }),
        );

        await vi.waitFor(() => expect(markSpy).toHaveBeenCalledTimes(1));
        expect(markSpy).toHaveBeenCalledWith('agent-stranger', 'failed', undefined);
        await deathSettled;
        const state = await store.load();
        expect(state.roster.agents[0]?.diedAt).toBeUndefined();
      } finally {
        markSpy.mockRestore();
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('clears the death mark when the agent starts again', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-revive-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init('session-main');
      await store.registerAgent({
        name: 'w1',
        kind: 'worker',
        agentId: 'agent-w1',
        sessionId: 'session-main',
        missionId: 'M1',
        spawnedAt: new Date().toISOString(),
      });
      await store.markAgentDied('agent-w1', 'failed', 'provider blew up');
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-main' } as unknown as ISessionContext);
      ix.get(IAgentTowerService);

      publishAsMain(ix, new SubagentStarted({ subagentId: 'agent-w1' }));

      await vi.waitFor(async () => {
        const state = await store.load();
        expect(state.roster.agents[0]?.diedAt).toBeUndefined();
      });
      const state = await store.load();
      expect(state.roster.agents[0]?.deathStatus).toBeUndefined();
      const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
      expect(log).toContain('revived');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter(base) rebases the workspace while tower mode is already active', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-rebase-active-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await execFileAsync('git', ['branch', 'develop'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init('session-main', 'main');
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-main' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await tower.enter('main');
      expect(tower.isActive).toBe(true);

      await tower.enter('develop');

      expect(tower.requestedBase).toBe('develop');
      expect((await store.load()).base).toBe('develop');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('dispatch persists enter/exit records and replay rebuilds the flag (silent)', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }
    expect(records).toEqual([
      { type: 'tower_mode.enter', agentId: 'main', time: expect.any(Number) },
    ]);

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-replay'), {
      log: ix2.get(IAppendLogStore),
    });
    stubMainAgentScope(ix2);
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.get(IAgentStateService).contributeState(towerKey);
    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-replay'),
      records,
    );
    expect(ix2.get(IAgentStateService).get(towerKey)).toBe(true);
  });

  it('replays legacy v1 tower_mode records written without a payload', async () => {
    const records: WireRecord[] = [
      { type: 'tower_mode.enter', time: 1 },
      { type: 'tower_mode.exit', time: 2 },
      { type: 'tower_mode.enter', time: 3 },
    ];

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-legacy'), {
      log: ix2.get(IAppendLogStore),
    });
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.get(IAgentStateService).contributeState(towerKey);
    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-legacy'),
      records,
    );
    expect(ix2.get(IAgentStateService).get(towerKey)).toBe(true);
  });

  it('leaves AskUserQuestion alone while tower mode is active (the tower may ask)', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const decision = await fire(hookContext([toolCall('AskUserQuestion', 'call_ask')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });

  it('abstains on AskUserQuestion while tower mode is inactive', async () => {
    ix.get(IAgentTowerService);

    const decision = await fire(hookContext([toolCall('AskUserQuestion', 'call_ask')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });

  it('vetoes TodoList while tower mode is active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const decision = await fire(hookContext([toolCall('TodoList', 'call_todo')]));

    expect(decision).toEqual({
      veto: {
        output: expect.stringContaining('TodoList is not available while tower mode is active'),
        isError: true,
      },
    });
    expect(permissionGateRan).toBe(false);
    expect(formatDenyMessage).toHaveBeenCalledTimes(1);
  });

  it('abstains on TodoList while tower mode is inactive', async () => {
    ix.get(IAgentTowerService);

    const decision = await fire(hookContext([toolCall('TodoList', 'call_todo')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });

  it('abstains on other tools while tower mode is active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const decision = await fire(hookContext([toolCall('Bash', 'call_bash')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });

  it('denies tower tools while the tower flag is off, even with the mode active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();
    expect(tower.isActive).toBe(true);
    towerFlagOn = false;

    const decision = await fire(hookContext([toolCall('TowerTeardown', 'call_td')]));

    expect(decision).toEqual({
      veto: {
        output: expect.stringContaining('The tower experiment is disabled'),
        isError: true,
      },
    });
    expect(permissionGateRan).toBe(false);
    expect(formatDenyMessage).toHaveBeenCalledTimes(1);
  });

  it('enter() is a no-op while the tower flag is off', async () => {
    towerFlagOn = false;
    const tower = ix.get(IAgentTowerService);
    const events: { readonly type: string }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') events.push({ type: e.type });
      }),
    );

    await tower.enter();

    expect(tower.isActive).toBe(false);
    expect(events).toEqual([]);
  });

  it('enter() is a no-op until the feature is assembled — a live flag flip needs a restart', async () => {
    _setTowerFeatureAssembledForTests(false);
    try {
      const tower = ix.get(IAgentTowerService);

      await tower.enter();

      expect(tower.isActive).toBe(false);
      expect(addedTools).toEqual([]);
    } finally {
      _setTowerFeatureAssembledForTests(true);
    }
  });

  it('publishes towerMode:false when the tower feature becomes unavailable while active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();
    expect(tower.isActive).toBe(true);
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );

    _setTowerFeatureAssembledForTests(false);
    try {
      fireUnitsChanged();

      expect(tower.isActive).toBe(false);
      expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: false });
    } finally {
      _setTowerFeatureAssembledForTests(true);
    }
  });

  it('publishes towerMode:false when the flag is disabled through a live config change', async () => {
    let fireConfigChanged: () => void = () => {};
    ix.stub(IConfigService, {
      onDidChangeConfiguration: (handler: () => void) => {
        fireConfigChanged = handler;
        return { dispose: () => {} };
      },
    } as unknown as IConfigService);
    const tower = ix.get(IAgentTowerService);
    await tower.enter();
    expect(tower.isActive).toBe(true);
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );

    towerFlagOn = false;
    fireConfigChanged();

    expect(tower.isActive).toBe(false);
    expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: false });

    towerFlagOn = true;
    fireConfigChanged();

    expect(tower.isActive).toBe(true);
    expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: true });
  });

  function stubLiveSession(
    id: string,
    init: { busy?: boolean; pendingInteraction?: SessionPendingInteraction } = {},
  ): Mock<() => void> {
    const exit = vi.fn();
    liveSessions.set(id, {
      busy: init.busy ?? false,
      pendingInteraction: init.pendingInteraction ?? 'none',
      exit,
    });
    return exit;
  }

  it('enter() is a no-op while a busy foreign session owns the tower in this process', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-foreign-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await new TowerStore(repo).init('session-original');

      stubLiveSession('session-original', { busy: true });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await tower.enter();

      expect(tower.isActive).toBe(false);
      expect(addedTools).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter() is a no-op while the owning session waits on an interaction', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-pending-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await new TowerStore(repo).init('session-original');

      stubLiveSession('session-original', { pendingInteraction: 'approval' });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await tower.enter();

      expect(tower.isActive).toBe(false);
      expect(addedTools).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter() takes the tower over from a live but idle owner session', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-takeover-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await new TowerStore(repo).init('session-original');

      const ownerExit = stubLiveSession('session-original');
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await tower.enter();

      expect(tower.isActive).toBe(true);
      expect(addedTools).toEqual([...TOWER_MODE_TOOLS]);
      expect(ownerExit).toHaveBeenCalledTimes(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter() adopts the tower once the owning session is gone — TowerInit stays reachable', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-stale-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await new TowerStore(repo).init('session-original');

      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await tower.enter();

      expect(tower.isActive).toBe(true);
      expect(addedTools).toEqual([...TOWER_MODE_TOOLS]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('does not veto TodoList while the tower flag is off, even with tower mode persisted active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();
    expect(tower.isActive).toBe(true);
    towerFlagOn = false;

    const decision = await fire(hookContext([toolCall('TodoList', 'call_todo')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
    expect(tower.isActive).toBe(false);
  });

  it('enter activates the tower tool set on the main agent; exit keeps it', async () => {
    const tower = ix.get(IAgentTowerService);

    await tower.enter();
    expect(addedTools).toEqual([...TOWER_MODE_TOOLS]);
    expect(removedTools).toEqual([]);

    tower.exit();
    expect(removedTools).toEqual([]);
  });

  it('enter is inert on a non-main agent', async () => {
    ix.stub(
      IAgentScopeContext,
      makeAgentScopeContext({ agentId: 'test-agent', agentScope: testWireScope('wire', 'tower-test'), generation: 0 }),
    );
    const tower = ix.get(IAgentTowerService);

    await tower.enter();

    expect(tower.isActive).toBe(false);
    expect(addedTools).toEqual([]);

    tower.exit();
    expect(removedTools).toEqual([]);
  });

  it('restore re-applies the tower tool set and re-emits the status while active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }
    expect(records).toEqual([
      { type: 'tower_mode.enter', agentId: 'main', time: expect.any(Number) },
    ]);

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
    ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
    ix2.stub(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID));
    ix2.stub(ISessionContext, { cwd: '/nonexistent-tower-repo' } as unknown as ISessionContext);
    ix2.stub(
      IAgentReminderService,
      createReminderStub(),
    );
    ix2.stub(IAgentContextMemoryService, {
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    const restoredAdded: string[] = [];
    ix2.stub(IAgentProfileService, {
      data: () => ({ profileName: undefined }),
      addActiveTool: (name: string) => {
        restoredAdded.push(name);
      },
      removeActiveTool: () => {},
    } as unknown as IAgentProfileService);
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-restore'), {
      log: ix2.get(IAppendLogStore),
      eventBus: ix2.get(IEventBus),
    });
    stubMainAgentScope(ix2);
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix2.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );
    ix2.get(IAgentTowerService);

    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-restore'),
      records,
    );

    expect(restoredAdded).toEqual([...TOWER_MODE_TOOLS]);
    expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: true });
  });

  it('exit clears persisted tower state even while the tower flag is off', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();
    expect(tower.isActive).toBe(true);

    towerFlagOn = false;
    expect(tower.isActive).toBe(false);

    tower.exit();

    towerFlagOn = true;
    expect(tower.isActive).toBe(false);
  });

  it('reapplies the tower tool set when a profile change wipes the allow-list', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();
    expect(addedTools).toEqual([...TOWER_MODE_TOOLS]);

    addedTools.length = 0;
    activeTools = ['Bash'];
    const events: { readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );
    publishAsMain(ix, new AgentStatusUpdated({ agentId: 'main' }));

    expect(addedTools).toEqual([...TOWER_MODE_TOOLS]);
    expect(activeTools).toEqual(['Bash', ...TOWER_MODE_TOOLS]);
    expect(events).toContainEqual({ towerMode: true });
  });

  it('restore keeps the feature inert while the tower flag is off', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
    ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
    ix2.stub(IFlagService, stubFlag(() => false));
    ix2.stub(ISessionContext, { cwd: '/nonexistent-tower-repo' } as unknown as ISessionContext);
    ix2.stub(
      IAgentReminderService,
      createReminderStub(),
    );
    ix2.stub(IAgentContextMemoryService, {
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    const restoredAdded: string[] = [];
    ix2.stub(IAgentProfileService, {
      data: () => ({ profileName: undefined }),
      addActiveTool: (name: string) => {
        restoredAdded.push(name);
      },
      removeActiveTool: () => {},
    } as unknown as IAgentProfileService);
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-restore-flag-off'), {
      log: ix2.get(IAppendLogStore),
      eventBus: ix2.get(IEventBus),
    });
    stubMainAgentScope(ix2);
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix2.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );
    const restored = ix2.get(IAgentTowerService);

    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-restore-flag-off'),
      records,
    );

    expect(restored.isActive).toBe(false);
    expect(restoredAdded).toEqual([]);
    expect(events).toEqual([{ type: 'agent.status.updated', towerMode: false }]);
  });

  it('restore keeps a persisted enter record inert on a non-main agent', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
    ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
    ix2.stub(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID));
    ix2.stub(ISessionContext, { cwd: '/nonexistent-tower-repo' } as unknown as ISessionContext);
    ix2.stub(
      IAgentReminderService,
      createReminderStub(),
    );
    ix2.stub(IAgentContextMemoryService, {
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    const restoredAdded: string[] = [];
    ix2.stub(IAgentProfileService, {
      data: () => ({ profileName: undefined }),
      addActiveTool: (name: string) => {
        restoredAdded.push(name);
      },
      removeActiveTool: () => {},
    } as unknown as IAgentProfileService);
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-restore-non-main'), {
      log: ix2.get(IAppendLogStore),
      eventBus: ix2.get(IEventBus),
    });
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix2.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );
    const restored = ix2.get(IAgentTowerService);

    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-restore-non-main'),
      records,
    );

    expect(restored.isActive).toBe(false);
    expect(restoredAdded).toEqual([]);
    expect(events).toEqual([]);
  });

  it('exits a replayed tower mode when the store owner is another session (fork)', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }

    const repo = await mkdtemp(join(tmpdir(), 'tower-fork-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await new TowerStore(repo).init('session-original');

      const ix2 = disposables.add(new TestInstantiationService());
      ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
      ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
      ix2.set(IEventBus, new SyncDescriptor(EventBusService));
      ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
      ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
      ix2.stub(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID));
      ix2.stub(ISessionManager, {
        get: (id: string) => (id === 'session-original' ? {} : undefined),
      } as unknown as ISessionManager);
      ix2.stub(ISessionContext, {
        cwd: repo,
        sessionId: 'session-fork',
      } as unknown as ISessionContext);
      ix2.stub(
        IAgentReminderService,
        createReminderStub(),
      );
      ix2.stub(IAgentContextMemoryService, {
        get: () => [],
      } as unknown as IAgentContextMemoryService);
      const restoredAdded: string[] = [];
      ix2.stub(IAgentProfileService, {
        data: () => ({ profileName: undefined }),
        addActiveTool: (name: string) => {
          restoredAdded.push(name);
        },
        removeActiveTool: () => {},
      } as unknown as IAgentProfileService);
      registerTestAgentWire(ix2, testWireScope('wire', 'tower-fork-restore'), {
        log: ix2.get(IAppendLogStore),
        eventBus: ix2.get(IEventBus),
      });
      stubMainAgentScope(ix2);
      const dispatcher = registerTestEventDispatcher(ix2);
      ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
      const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
      disposables.add(
        ix2.get(IEventBus).subscribe((e) => {
          if (e.type === 'agent.status.updated') {
            events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
          }
        }),
      );
      const restored = ix2.get(IAgentTowerService);

      await restoreTestEventDispatcher(
        dispatcher,
        ix2.get(IAppendLogStore),
        testWireScope('wire', 'tower-fork-restore'),
        records,
      );

      expect(restored.isActive).toBe(false);
      expect(restoredAdded).toEqual([]);
      expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: false });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('keeps a replayed tower mode when the store owner session is gone — adoption survives resume', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }

    const repo = await mkdtemp(join(tmpdir(), 'tower-fork-stale-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await new TowerStore(repo).init('session-original');

      const ix2 = disposables.add(new TestInstantiationService());
      ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
      ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
      ix2.set(IEventBus, new SyncDescriptor(EventBusService));
      ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
      ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
      ix2.stub(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID));
      ix2.stub(ISessionManager, {
        get: () => undefined,
      } as unknown as ISessionManager);
      ix2.stub(ISessionContext, {
        cwd: repo,
        sessionId: 'session-fork',
      } as unknown as ISessionContext);
      ix2.stub(
        IAgentReminderService,
        createReminderStub(),
      );
      ix2.stub(IAgentContextMemoryService, {
        get: () => [],
      } as unknown as IAgentContextMemoryService);
      const restoredAdded: string[] = [];
      ix2.stub(IAgentProfileService, {
        data: () => ({ profileName: undefined }),
        addActiveTool: (name: string) => {
          restoredAdded.push(name);
        },
        removeActiveTool: () => {},
      } as unknown as IAgentProfileService);
      registerTestAgentWire(ix2, testWireScope('wire', 'tower-fork-stale-restore'), {
        log: ix2.get(IAppendLogStore),
        eventBus: ix2.get(IEventBus),
      });
      stubMainAgentScope(ix2);
      const dispatcher = registerTestEventDispatcher(ix2);
      ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
      const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
      disposables.add(
        ix2.get(IEventBus).subscribe((e) => {
          if (e.type === 'agent.status.updated') {
            events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
          }
        }),
      );
      const restored = ix2.get(IAgentTowerService);

      await restoreTestEventDispatcher(
        dispatcher,
        ix2.get(IAppendLogStore),
        testWireScope('wire', 'tower-fork-stale-restore'),
        records,
      );

      expect(restored.isActive).toBe(true);
      expect(restoredAdded).toEqual([...TOWER_MODE_TOOLS]);
      expect(events).not.toContainEqual({ type: 'agent.status.updated', towerMode: false });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exits a replayed tower mode on a fork restored while the flag is off when the owner is live', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }

    const repo = await mkdtemp(join(tmpdir(), 'tower-fork-flag-off-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await new TowerStore(repo).init('session-original');

      const ix2 = disposables.add(new TestInstantiationService());
      ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
      ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
      ix2.set(IEventBus, new SyncDescriptor(EventBusService));
      ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
      ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
      ix2.stub(IFlagService, stubFlag(() => false));
      ix2.stub(ISessionManager, {
        get: (id: string) => (id === 'session-original' ? {} : undefined),
      } as unknown as ISessionManager);
      ix2.stub(ISessionContext, {
        cwd: repo,
        sessionId: 'session-fork',
      } as unknown as ISessionContext);
      ix2.stub(
        IAgentReminderService,
        createReminderStub(),
      );
      ix2.stub(IAgentContextMemoryService, {
        get: () => [],
      } as unknown as IAgentContextMemoryService);
      const restoredAdded: string[] = [];
      ix2.stub(IAgentProfileService, {
        data: () => ({ profileName: undefined }),
        addActiveTool: (name: string) => {
          restoredAdded.push(name);
        },
        removeActiveTool: () => {},
      } as unknown as IAgentProfileService);
      registerTestAgentWire(ix2, testWireScope('wire', 'tower-fork-flag-off-restore'), {
        log: ix2.get(IAppendLogStore),
        eventBus: ix2.get(IEventBus),
      });
      stubMainAgentScope(ix2);
      const dispatcher = registerTestEventDispatcher(ix2);
      ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
      const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
      disposables.add(
        ix2.get(IEventBus).subscribe((e) => {
          if (e.type === 'agent.status.updated') {
            events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
          }
        }),
      );
      const restored = ix2.get(IAgentTowerService);

      await restoreTestEventDispatcher(
        dispatcher,
        ix2.get(IAppendLogStore),
        testWireScope('wire', 'tower-fork-flag-off-restore'),
        records,
      );

      expect(restored.isActive).toBe(false);
      expect(restoredAdded).toEqual([]);
      expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: false });
      expect(ix2.get(IAgentStateService).get(towerKey)).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exits a replayed tower mode without a store when the enter record belongs to another session', async () => {
    ix.stub(ISessionContext, {
      cwd: '/nonexistent-tower-repo',
      sessionId: 'session-original',
    } as unknown as ISessionContext);
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
    ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
    ix2.stub(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID));
    ix2.stub(ISessionManager, {
      get: (id: string) => (id === 'session-original' ? {} : undefined),
    } as unknown as ISessionManager);
    ix2.stub(ISessionContext, {
      cwd: '/nonexistent-tower-repo',
      sessionId: 'session-fork',
    } as unknown as ISessionContext);
    ix2.stub(
      IAgentReminderService,
      createReminderStub(),
    );
    ix2.stub(IAgentContextMemoryService, {
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    const restoredAdded: string[] = [];
    ix2.stub(IAgentProfileService, {
      data: () => ({ profileName: undefined }),
      addActiveTool: (name: string) => {
        restoredAdded.push(name);
      },
      removeActiveTool: () => {},
    } as unknown as IAgentProfileService);
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-fork-noinit'), {
      log: ix2.get(IAppendLogStore),
      eventBus: ix2.get(IEventBus),
    });
    stubMainAgentScope(ix2);
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix2.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );
    const restored = ix2.get(IAgentTowerService);

    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-fork-noinit'),
      records,
    );

    expect(restored.isActive).toBe(false);
    expect(restoredAdded).toEqual([]);
    expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: false });
  });

  it('restores a pre-init tower mode on the owning session even without a store', async () => {
    ix.stub(ISessionContext, {
      cwd: '/nonexistent-tower-repo',
      sessionId: 'session-owner',
    } as unknown as ISessionContext);
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
    ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
    ix2.stub(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID));
    ix2.stub(ISessionContext, {
      cwd: '/nonexistent-tower-repo',
      sessionId: 'session-owner',
    } as unknown as ISessionContext);
    ix2.stub(
      IAgentReminderService,
      createReminderStub(),
    );
    ix2.stub(IAgentContextMemoryService, {
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    const restoredAdded: string[] = [];
    ix2.stub(IAgentProfileService, {
      data: () => ({ profileName: undefined }),
      addActiveTool: (name: string) => {
        restoredAdded.push(name);
      },
      removeActiveTool: () => {},
    } as unknown as IAgentProfileService);
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-resume-noinit'), {
      log: ix2.get(IAppendLogStore),
      eventBus: ix2.get(IEventBus),
    });
    stubMainAgentScope(ix2);
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix2.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );
    const restored = ix2.get(IAgentTowerService);

    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-resume-noinit'),
      records,
    );

    expect(restored.isActive).toBe(true);
    expect(restoredAdded).toEqual([...TOWER_MODE_TOOLS]);
    expect(events).not.toContainEqual({ type: 'agent.status.updated', towerMode: false });
  });

  it('restore does not touch the profile tool overlay while tower mode is inactive', async () => {
    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
    ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
    ix2.stub(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID));
    ix2.stub(ISessionContext, { cwd: '/nonexistent-tower-repo' } as unknown as ISessionContext);
    ix2.stub(
      IAgentReminderService,
      createReminderStub(),
    );
    ix2.stub(IAgentContextMemoryService, {
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    const restoredAdded: string[] = [];
    ix2.stub(IAgentProfileService, {
      data: () => ({ profileName: undefined }),
      addActiveTool: (name: string) => {
        restoredAdded.push(name);
      },
      removeActiveTool: () => {},
    } as unknown as IAgentProfileService);
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-restore-idle'), {
      log: ix2.get(IAppendLogStore),
      eventBus: ix2.get(IEventBus),
    });
    stubMainAgentScope(ix2);
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
    ix2.get(IAgentTowerService);

    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-restore-idle'),
      [],
    );

    expect(restoredAdded).toEqual([]);
  });

  describe('tower-worker write guard', () => {
    const WORKER_AGENT_ID = 'agent-worker-1';
    let repo: string;
    let worktree: string;

    async function git(cwd: string, ...args: string[]): Promise<void> {
      await execFileAsync('git', args, { cwd });
    }

    beforeEach(async () => {
      repo = await mkdtemp(join(tmpdir(), 'tower-guard-test-'));
      await git(repo, 'init', '-b', 'main');
      await git(repo, 'config', 'user.email', 'tower-test@example.com');
      await git(repo, 'config', 'user.name', 'Tower Test');
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await git(repo, 'add', 'README.md');
      await git(repo, 'commit', '-m', 'initial');
      const store = new TowerStore(repo);
      await store.init();
      await store.registerAgent({
        name: 'agent-build',
        agentId: WORKER_AGENT_ID,
        kind: 'worker',
        missionId: 'M1',
        worktree: 'wt-1',
        branch: 'feat/build',
        spawnedAt: new Date().toISOString(),
      });
      worktree = join(repo, '.tower/worktrees/wt-1');

      ix.stub(IAgentProfileService, {
        data: () => ({ profileName: 'tower-worker' }),
      } as unknown as IAgentProfileService);
      ix.stub(
        IAgentScopeContext,
        makeAgentScopeContext({ agentId: WORKER_AGENT_ID, agentScope: testWireScope('wire', 'tower-test'), generation: 0 }),
      );
      ix.stub(ISessionContext, { cwd: repo } as unknown as ISessionContext);
    });

    afterEach(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    it('allows a worker Write inside its own worktree', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(writeHookContext('Write', [`${worktree}/src/gemm.cpp`]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('denies a worker Write outside its worktree', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(
        writeHookContext('Edit', [`${repo}/src/gemm.cpp`, `${repo}/.tower/worktrees/wt-2/x.ts`]),
      );

      expect(decision?.veto?.isError).toBe(true);
      const output = decision?.veto?.output;
      expect(output).toContain(`tower workers may only write inside their own worktree (${worktree})`);
      expect(output).toContain(`${repo}/src/gemm.cpp`);
      expect(output).toContain(`${repo}/.tower/worktrees/wt-2/x.ts`);
      expect(output).toContain('TowerFinding');
      expect(output).toContain('TowerSend');
      expect(permissionGateRan).toBe(false);
      expect(formatDenyMessage).toHaveBeenCalledTimes(1);
    });

    it('abstains on non-Write/Edit tools for a worker', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(hookContext([toolCall('Bash', 'call_bash')]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('guards worker writes even while the tower flag is off — isolation is identity-scoped', async () => {
      towerFlagOn = false;
      ix.get(IAgentTowerService);

      const decision = await fire(writeHookContext('Write', [`${repo}/src/gemm.cpp`]));

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain(
        'tower workers may only write inside their own worktree',
      );
      expect(permissionGateRan).toBe(false);
      expect(formatDenyMessage).toHaveBeenCalledTimes(1);
    });

    it('abstains when the agent is not a tower worker', async () => {
      ix.stub(IAgentProfileService, {
        data: () => ({ profileName: 'coder' }),
      } as unknown as IAgentProfileService);
      ix.get(IAgentTowerService);

      const decision = await fire(writeHookContext('Write', [`${repo}/src/gemm.cpp`]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('abstains when the worker has no roster entry', async () => {
      ix.stub(
        IAgentScopeContext,
        makeAgentScopeContext({ agentId: 'agent-unregistered', agentScope: testWireScope('wire', 'tower-test'), generation: 0 }),
      );
      ix.get(IAgentTowerService);

      const decision = await fire(writeHookContext('Write', [`${repo}/src/gemm.cpp`]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });
  });
});

async function injectDynamic(ctx: TestAgentContext): Promise<void> {
  await runWillBeginStepHooks(ctx.get(IAgentLoopService) as StubLoop, false);
}

function appendAssistantTurn(
  ctx: TestAgentContext,
  context: IAgentContextMemoryService,
  text: string,
): void {
  ctx.appendAssistantTurn(context.get().length, text);
}

function towerReminderMessages(context: IAgentContextMemoryService): readonly ContextMessage[] {
  return context.get().filter((message) => {
    return message.origin?.kind === 'injection' && message.origin.variant === 'tower_mode';
  });
}

function lastTowerReminder(context: IAgentContextMemoryService): string {
  const message = towerReminderMessages(context).at(-1);
  if (message === undefined) return '';
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

describe('TowerModeInjection', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let tower: IAgentTowerService;
  let towerFlagOn: boolean;
  let cwd: string;

  beforeEach(async () => {
    towerFlagOn = true;
    cwd = await mkdtemp(join(tmpdir(), 'tower-injection-'));
    ctx = createTestAgent(
      { cwd },
      appService(IFlagService, stubFlag((id) => towerFlagOn && id === TOWER_FLAG_ID)),
    );
    context = ctx.get(IAgentContextMemoryService);
    tower = ctx.get(IAgentTowerService);
    await ctx.restorePersisted();
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('injects the full reminder when tower mode turns on', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    const text = lastTowerReminder(context);

    expect(text).toContain('Tower mode is active');
    expect(text).toContain('TowerSpawn');
    expect(text).toContain('TowerMerge');
  });

  it('injects the exit reminder when tower mode turns off after being active', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    tower.exit();
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(2);
    expect(lastTowerReminder(context)).toContain('Tower mode is no longer active');
  });

  it('emits the exit reminder once when the tower flag is turned off with an active reminder in context', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    expect(towerReminderMessages(context)).toHaveLength(1);

    towerFlagOn = false;
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(2);
    expect(lastTowerReminder(context)).toContain('Tower mode is no longer active');

    appendAssistantTurn(ctx, context, 'assistant one');
    await injectDynamic(ctx);
    ctx.appendUserMessage([{ type: 'text', text: 'next task' }]);
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(2);
  });

  it('does not inject anything when tower mode is inactive from the start', async () => {
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(0);
    expect(context.get()).toHaveLength(0);
  });

  it('skips reinjection before the assistant-turn threshold', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    appendAssistantTurn(ctx, context, 'assistant one');
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(1);
  });

  it('injects the sparse reminder after the short assistant-turn threshold', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    appendAssistantTurn(ctx, context, 'assistant one');
    appendAssistantTurn(ctx, context, 'assistant two');
    await injectDynamic(ctx);

    const text = lastTowerReminder(context);
    expect(text).toContain('Tower mode still active');
    expect(text).toContain('see full instructions earlier');
  });

  it('refreshes the full reminder after the long assistant-turn threshold', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    for (let i = 0; i < 5; i += 1) {
      appendAssistantTurn(ctx, context, `assistant ${String(i)}`);
    }
    await injectDynamic(ctx);

    const text = lastTowerReminder(context);
    expect(text).toContain('Tower mode is active');
    expect(text).not.toContain('Tower mode still active');
  });

  it('refreshes the full reminder when a user message follows at least one assistant turn', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    appendAssistantTurn(ctx, context, 'assistant one');
    ctx.appendUserMessage([{ type: 'text', text: 'next task' }]);
    await injectDynamic(ctx);

    const text = lastTowerReminder(context);
    expect(text).toContain('Tower mode is active');
    expect(text).not.toContain('Tower mode still active');
  });

  it('does not duplicate the full reminder when the first objective follows activation directly', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    ctx.appendUserMessage([{ type: 'text', text: 'first objective' }]);
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(1);
  });

  it('emits the exit reminder only once and returns the full reminder on re-entry', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    tower.exit();
    await injectDynamic(ctx);
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(2);

    await tower.enter();
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(3);
    expect(lastTowerReminder(context)).toContain('Tower mode is active');
  });
});
