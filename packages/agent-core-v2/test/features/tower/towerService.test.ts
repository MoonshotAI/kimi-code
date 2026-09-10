import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { createReminderStub } from '../reminder/stubs';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { runWillBeginStepHooks, stubLoopWithHooks, type StubLoop } from '../../agent/loop/stubs';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { TowerStore } from '#/features/tower/protocol/index';
import { TowerSendTool } from '#/features/tower/tools/send/sendTool';
import {
  IAgentTowerService,
  TOWER_FLAG_ID,
  towerEnterFailureMessage,
  type TowerEnterFailure,
} from '#/features/tower/tower';
import { _setTowerFeatureAssembledForTests } from '#/features/tower/towerFeature';
import { AgentTowerService, TOWER_INBOX_WAKE_VARIANT, TOWER_MODE_TOOLS } from '#/features/tower/towerService';
import { towerKey, TowerInboxSent } from '#/features/tower/towerOps';
import { TaskTerminatedNotice } from '#/agent/task/taskOps';
import { IAgentTaskService } from '#/agent/task/task';
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
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import type { ToolCall } from '#human/llm/message';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ToolAccesses } from '#/tool/toolContract';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../../agent/toolExecutor/stubs';
import { executeTool } from '../../tools/fixtures/execute-tool';
import { stubFlag } from '../../app/flag/stubs';
import { stubLog } from '../../_base/log/stubs';
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
  let policyInactiveTools: string[];
  let liveSessions: Map<string, { busy: boolean; pendingInteraction: SessionPendingInteraction; exit: Mock<() => void>; title?: string; metadataReadFails?: boolean }>;
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
              if (token === (ISessionMetadata as unknown)) {
                return {
                  read: async () => {
                    if (stub.metadataReadFails === true) throw new Error('metadata read failed');
                    return { title: stub.title };
                  },
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
    policyInactiveTools = [];
    ix.stub(IAgentToolPolicyService, {
      isToolActive: (name: string) => !policyInactiveTools.includes(name),
    } as unknown as IAgentToolPolicyService);
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
    ix.stub(ILogService, stubLog());
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
    await expect(tower.enter()).resolves.toEqual({ entered: true });
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

  it('enter() reports experiment-off while the tower flag is off', async () => {
    towerFlagOn = false;
    const tower = ix.get(IAgentTowerService);
    const events: { readonly type: string }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') events.push({ type: e.type });
      }),
    );

    await expect(tower.enter()).resolves.toEqual({ entered: false, reason: 'experiment-off' });

    expect(tower.isActive).toBe(false);
    expect(events).toEqual([]);
  });

  it('enter() reports feature-not-assembled until the feature is assembled — a live flag flip needs a restart', async () => {
    _setTowerFeatureAssembledForTests(false);
    try {
      const tower = ix.get(IAgentTowerService);

      await expect(tower.enter()).resolves.toEqual({ entered: false, reason: 'feature-not-assembled' });

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
    init: { busy?: boolean; pendingInteraction?: SessionPendingInteraction; title?: string; metadataReadFails?: boolean } = {},
  ): Mock<() => void> {
    const exit = vi.fn();
    liveSessions.set(id, {
      busy: init.busy ?? false,
      pendingInteraction: init.pendingInteraction ?? 'none',
      exit,
      title: init.title,
      metadataReadFails: init.metadataReadFails,
    });
    return exit;
  }

  it('enter() reports owned-by-live-session with the owner id while a busy foreign session owns the tower in this process', async () => {
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

      await expect(tower.enter()).resolves.toEqual({
        entered: false,
        reason: 'owned-by-live-session',
        owner: 'session-original',
      });

      expect(tower.isActive).toBe(false);
      expect(addedTools).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter() reports owned-by-live-session while the owning session waits on an interaction', async () => {
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

      await expect(tower.enter()).resolves.toEqual({
        entered: false,
        reason: 'owned-by-live-session',
        owner: 'session-original',
      });

      expect(tower.isActive).toBe(false);
      expect(addedTools).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter() includes the live owner session title in the owned-by-live-session result', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-owner-title-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await new TowerStore(repo).init('session-original');

      stubLiveSession('session-original', { busy: true, title: 'Tower docs polish' });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await expect(tower.enter()).resolves.toEqual({
        entered: false,
        reason: 'owned-by-live-session',
        owner: 'session-original',
        ownerTitle: 'Tower docs polish',
      });

      expect(tower.isActive).toBe(false);
      expect(addedTools).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter() bootstraps a non-git directory before preparing the requested base', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tower-enter-nogit-'));
    try {
      await writeFile(join(dir, 'notes.md'), '# scratch\n');
      ix.stub(ISessionContext, { cwd: dir, sessionId: 'session-fresh' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      const result = await tower.enter('tower-base');

      expect(result).toEqual({ entered: true });
      expect(tower.isActive).toBe(true);
      const { stdout: subject } = await execFileAsync('git', ['log', '-1', '--format=%s'], {
        cwd: dir,
      });
      expect(subject.trim()).toBe(
        'tower: snapshot of uncommitted base checkout changes (base tower-base)',
      );
      const { stdout: branch } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: dir,
      });
      expect(branch.trim()).toBe('tower-base');
      const { stdout: tracked } = await execFileAsync('git', ['ls-files'], { cwd: dir });
      expect(tracked).toContain('notes.md');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('enter() degrades to the owner id when the live owner has only a placeholder title', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-owner-untitled-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await new TowerStore(repo).init('session-original');

      stubLiveSession('session-original', { busy: true, title: 'New Session' });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      const result = await tower.enter();

      expect(result).toEqual({
        entered: false,
        reason: 'owned-by-live-session',
        owner: 'session-original',
        ownerTitle: undefined,
      });
      if (!result.entered) {
        expect(towerEnterFailureMessage(result)).toBe(
          'another live session owns the workspace tower (session session-original)',
        );
      }
      expect(tower.isActive).toBe(false);
      expect(addedTools).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter() degrades to the owner id when the live owner metadata cannot be read', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-owner-unreadable-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await new TowerStore(repo).init('session-original');

      stubLiveSession('session-original', { busy: true, metadataReadFails: true });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      const result = await tower.enter();

      expect(result).toEqual({
        entered: false,
        reason: 'owned-by-live-session',
        owner: 'session-original',
        ownerTitle: undefined,
      });
      if (!result.entered) {
        expect(towerEnterFailureMessage(result)).toBe(
          'another live session owns the workspace tower (session session-original)',
        );
      }
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

  it('exit() releases workspace ownership recorded under this session', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-exit-release-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init('session-main');
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-main' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await tower.enter();
      tower.exit();

      expect(tower.isActive).toBe(false);
      await vi.waitFor(async () => {
        expect((await store.load()).sessionId).toBeUndefined();
      });
      const log = await store.recentLog(5);
      expect(log.some((line) => line.includes(' release ') && line.includes('session=session-main'))).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exit() keeps workspace ownership recorded under another session', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-exit-foreign-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init('session-original');
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await tower.enter();
      expect(tower.isActive).toBe(true);

      let releaseSettled = Promise.resolve();
      const originalRelease = TowerStore.prototype.release;
      const releaseSpy = vi
        .spyOn(TowerStore.prototype, 'release')
        .mockImplementation(function (this: TowerStore, sessionId) {
          const pending = originalRelease.call(this, sessionId);
          releaseSettled = pending.then(
            () => undefined,
            () => undefined,
          );
          return pending;
        });
      try {
        tower.exit();

        await vi.waitFor(() => expect(releaseSpy).toHaveBeenCalledWith('session-fork'));
        await releaseSettled;
        expect(tower.isActive).toBe(false);
        expect((await store.load()).sessionId).toBe('session-original');
      } finally {
        releaseSpy.mockRestore();
      }
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

  it('enter reports not-main-agent and is inert on a non-main agent', async () => {
    ix.stub(
      IAgentScopeContext,
      makeAgentScopeContext({ agentId: 'test-agent', agentScope: testWireScope('wire', 'tower-test'), generation: 0 }),
    );
    const tower = ix.get(IAgentTowerService);

    await expect(tower.enter()).resolves.toEqual({ entered: false, reason: 'not-main-agent' });

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

      let releaseSettled = Promise.resolve();
      const originalRelease = TowerStore.prototype.release;
      const releaseSpy = vi
        .spyOn(TowerStore.prototype, 'release')
        .mockImplementation(function (this: TowerStore, sessionId) {
          const pending = originalRelease.call(this, sessionId);
          releaseSettled = pending.then(
            () => undefined,
            () => undefined,
          );
          return pending;
        });
      try {
        await restoreTestEventDispatcher(
          dispatcher,
          ix2.get(IAppendLogStore),
          testWireScope('wire', 'tower-fork-restore'),
          records,
        );

        expect(restored.isActive).toBe(false);
        expect(restoredAdded).toEqual([]);
        expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: false });
        await vi.waitFor(() => expect(releaseSpy).toHaveBeenCalledWith('session-fork'));
        await releaseSettled;
        expect((await new TowerStore(repo).load()).sessionId).toBe('session-original');
      } finally {
        releaseSpy.mockRestore();
      }
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

  describe('TowerSendTool inbox wake signal', () => {
    let repo: string;
    let bus: EventBusService;
    let sent: { from: string; to: string; subject: string }[];

    beforeEach(async () => {
      repo = await mkdtemp(join(tmpdir(), 'tower-send-signal-'));
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
      await store.registerAgent({
        name: 'w2',
        kind: 'worker',
        agentId: 'agent-w2',
        sessionId: 'session-main',
        spawnedAt: new Date().toISOString(),
      });
      bus = new EventBusService();
      disposables.add(bus);
      sent = [];
      disposables.add(
        bus.subscribe(TowerInboxSent, (event) => {
          sent.push({ from: event.from, to: event.to, subject: event.subject });
        }),
      );
    });

    afterEach(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    async function sendAs(
      agentId: string,
      input: { to: string; subject: string; body: string },
    ): Promise<void> {
      const tool = new TowerSendTool(
        { cwd: repo } as unknown as ISessionContext,
        makeAgentScopeContext({ agentId, agentScope: testWireScope('wire', 'tower-test'), generation: 0 }),
        bus,
        { list: () => [] } as unknown as IAgentTaskService,
      );
      const result = await executeTool(tool, { turnId: 0, toolCallId: 'call_send', args: input, signal });
      expect(result.isError).toBeFalsy();
    }

    it('publishes an inbox event when a worker messages the tower', async () => {
      await sendAs('agent-w1', { to: 'tower', subject: 'need wider scope', body: 'x' });

      expect(sent).toEqual([{ from: 'w1', to: 'tower', subject: 'need wider scope' }]);
    });

    it('publishes an inbox event when a worker broadcasts', async () => {
      await sendAs('agent-w1', { to: 'all', subject: 'fyi fleet', body: 'x' });

      expect(sent).toEqual([{ from: 'w1', to: 'all', subject: 'fyi fleet' }]);
    });

    it('stays silent for a direct agent-to-agent message', async () => {
      await sendAs('agent-w1', { to: 'w2', subject: 'side channel', body: 'x' });

      expect(sent).toEqual([]);
    });

    it('stays silent when the tower itself broadcasts', async () => {
      await sendAs('main', { to: 'all', subject: 'tower broadcast', body: 'x' });

      expect(sent).toEqual([]);
    });
  });

  describe('inbox wake', () => {
    let loop: StubLoop;

    beforeEach(() => {
      loop = stubLoopWithHooks();
      ix.stub(IAgentLoopService, loop);
      ix.stub(ISessionEventBus, ix.get(IEventBus) as ISessionEventBus);
    });

    function publishInbox(input: { from: string; to: string; subject: string }): void {
      ix.get(IEventBus).publish(new TowerInboxSent(input));
    }

    async function flushWake(): Promise<void> {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }

    function drainWakeMessages(): ContextMessage[] {
      const appended: ContextMessage[] = [];
      loop.drainNextBatch({
        append: (...messages: ContextMessage[]) => {
          appended.push(...messages);
        },
      });
      return appended;
    }

    function wakeText(message: ContextMessage): string {
      return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    }

    it('wakes the main agent once when a worker messages the tower', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      publishInbox({ from: 'w1', to: 'tower', subject: 'need wider scope' });
      await flushWake();
      const messages = drainWakeMessages();

      expect(messages).toHaveLength(1);
      const message = messages[0]!;
      expect(message.role).toBe('user');
      expect(message.origin).toEqual({ kind: 'injection', variant: TOWER_INBOX_WAKE_VARIANT });
      const text = wakeText(message);
      expect(text).toContain('1 new tower inbox message');
      expect(text).toContain('w1');
      expect(text).toContain('need wider scope');
      expect(text).toContain('TowerInbox');
    });

    it('coalesces a burst of inbox messages into a single wake naming the latest', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      publishInbox({ from: 'w1', to: 'tower', subject: 'one' });
      publishInbox({ from: 'w2', to: 'all', subject: 'two' });
      publishInbox({ from: 'w1', to: 'tower', subject: 'three' });
      await flushWake();
      const messages = drainWakeMessages();

      expect(messages).toHaveLength(1);
      const text = wakeText(messages[0]!);
      expect(text).toContain('3 new tower inbox messages');
      expect(text).toContain('w1');
      expect(text).toContain('three');

      await flushWake();
      expect(drainWakeMessages()).toEqual([]);
    });

    it('schedules exactly one follow-up wake for messages arriving while a wake is pending', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      publishInbox({ from: 'w1', to: 'tower', subject: 'first' });
      await flushWake();
      publishInbox({ from: 'w2', to: 'tower', subject: 'second' });
      publishInbox({ from: 'w2', to: 'all', subject: 'third' });

      const first = drainWakeMessages();
      expect(first).toHaveLength(1);
      expect(wakeText(first[0]!)).toContain('1 new tower inbox message');

      await flushWake();
      const second = drainWakeMessages();
      expect(second).toHaveLength(1);
      expect(wakeText(second[0]!)).toContain('2 new tower inbox messages');
      expect(wakeText(second[0]!)).toContain('third');
    });

    it('ignores messages addressed to a specific agent and messages from the tower itself', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      publishInbox({ from: 'w1', to: 'w2', subject: 'direct' });
      publishInbox({ from: 'tower', to: 'all', subject: 'self broadcast' });
      await flushWake();

      expect(drainWakeMessages()).toEqual([]);
      expect(loop.hasPendingRequests()).toBe(false);
    });

    it('does not wake while tower mode is inactive', async () => {
      ix.get(IAgentTowerService);

      publishInbox({ from: 'w1', to: 'tower', subject: 'hello' });
      await flushWake();

      expect(drainWakeMessages()).toEqual([]);
      expect(loop.hasPendingRequests()).toBe(false);
    });

    it('drops a queued wake when tower mode exits before it is consumed', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      publishInbox({ from: 'w1', to: 'tower', subject: 'need wider scope' });
      await flushWake();
      expect(loop.hasPendingRequests()).toBe(true);

      tower.exit();

      expect(loop.hasPendingRequests()).toBe(false);
      expect(drainWakeMessages()).toEqual([]);
    });

    it('drops a queued wake when the tower becomes unavailable at runtime', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      publishInbox({ from: 'w1', to: 'tower', subject: 'need wider scope' });
      await flushWake();
      expect(loop.hasPendingRequests()).toBe(true);

      _setTowerFeatureAssembledForTests(false);
      try {
        fireUnitsChanged();

        expect(loop.hasPendingRequests()).toBe(false);
        expect(drainWakeMessages()).toEqual([]);
      } finally {
        _setTowerFeatureAssembledForTests(true);
      }
    });

    it('truncates a very long subject in the wake preview', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      publishInbox({ from: 'w1', to: 'tower', subject: 'x'.repeat(500) });
      await flushWake();
      const messages = drainWakeMessages();

      expect(messages).toHaveLength(1);
      const text = wakeText(messages[0]!);
      expect(text).not.toContain('x'.repeat(500));
      expect(text).toContain(`${'x'.repeat(120)}…`);
    });

    it('does not respond on a non-main agent', async () => {
      ix.stub(
        IAgentScopeContext,
        makeAgentScopeContext({ agentId: 'agent-w1', agentScope: testWireScope('wire', 'tower-test'), generation: 0 }),
      );
      ix.get(IAgentTowerService);

      publishInbox({ from: 'w2', to: 'tower', subject: 'hello' });
      await flushWake();

      expect(drainWakeMessages()).toEqual([]);
      expect(loop.hasPendingRequests()).toBe(false);
    });
  });

  describe('roster resume veto', () => {
    let repo: string;

    beforeEach(async () => {
      repo = await mkdtemp(join(tmpdir(), 'tower-resume-veto-'));
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
    });

    afterEach(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    function agentHookContext(args: Record<string, unknown>): ResolvedToolExecutionHookContext {
      const call = toolCall('Agent', 'call_agent');
      return {
        turnId: 0,
        signal,
        toolCall: call,
        toolCalls: [call],
        args,
        execution: { approvalRule: 'Agent', execute: async () => ({ output: '' }) },
      };
    }

    it('vetoes a foreground resume of a roster agent', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      const decision = await fire(
        agentHookContext({ resume: 'agent-w1', prompt: 'keep going', description: 'resume w1' }),
      );

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('run_in_background');
      expect(permissionGateRan).toBe(false);
      expect(formatDenyMessage).toHaveBeenCalledTimes(1);
    });

    it('vetoes a foreground resume whose id carries surrounding whitespace', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      const decision = await fire(
        agentHookContext({ resume: '  agent-w1\n', prompt: 'keep going', description: 'resume w1' }),
      );

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('run_in_background');
      expect(permissionGateRan).toBe(false);
    });

    it('allows resuming a roster agent with run_in_background=true', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      const decision = await fire(
        agentHookContext({
          resume: 'agent-w1',
          run_in_background: true,
          prompt: 'keep going',
          description: 'resume w1',
        }),
      );

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('allows a foreground resume of an agent outside the roster', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      const decision = await fire(
        agentHookContext({ resume: 'agent-stranger', prompt: 'keep going', description: 'resume stranger' }),
      );

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('allows a fresh foreground subagent without a resume id', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      const decision = await fire(
        agentHookContext({ prompt: 'build a thing', description: 'fresh subagent' }),
      );

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('abstains on a foreground roster resume when background task tools are unavailable', async () => {
      policyInactiveTools = ['TaskStop'];
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      const decision = await fire(
        agentHookContext({ resume: 'agent-w1', prompt: 'keep going', description: 'resume w1' }),
      );

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('abstains on a foreground roster resume while tower mode is inactive', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(
        agentHookContext({ resume: 'agent-w1', prompt: 'keep going', description: 'resume w1' }),
      );

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

describe('towerEnterFailureMessage', () => {
  it.each([
    [
      { entered: false, reason: 'not-main-agent' },
      'tower mode is only supported by the main agent',
    ],
    [
      { entered: false, reason: 'experiment-off' },
      'the tower experiment is disabled; enable it with KIMI_CODE_EXPERIMENTAL_TOWER=1 or `[experimental] tower = true` in config.toml',
    ],
    [
      { entered: false, reason: 'feature-not-assembled' },
      'the tower feature is not assembled in this process; a restart is required',
    ],
    [
      { entered: false, reason: 'owned-by-live-session', owner: 'session-original' },
      'another live session owns the workspace tower (session session-original)',
    ],
    [
      {
        entered: false,
        reason: 'owned-by-live-session',
        owner: 'session-original',
        ownerTitle: 'Tower docs polish',
      },
      'another live session owns the workspace tower (session Tower docs polish (session-original))',
    ],
  ] as [TowerEnterFailure, string][])('maps %o to its message', (failure, message) => {
    expect(towerEnterFailureMessage(failure)).toBe(message);
  });
});
