import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { PromptSubmitted } from '#/agent/prompt/promptEvents';
import { isUserCancellation } from '#/_base/utils/abort';
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
import { STATE_FILE, TowerStore, type TowerState } from '#/features/tower/protocol/index';
import { TowerSendTool } from '#/features/tower/tools/send/sendTool';
import { TowerReviewTool } from '#/features/tower/tools/review/reviewTool';
import { TowerCompleteTool } from '#/features/tower/tools/complete/completeTool';
import {
  IAgentTowerService,
  TOWER_FLAG_ID,
  towerEnterFailureMessage,
  type TowerEnterFailure,
} from '#/features/tower/tower';
import { _setTowerFeatureAssembledForTests } from '#/features/tower/towerFeature';
import { AgentTowerService, TOWER_INBOX_WAKE_VARIANT, TOWER_MODE_TOOLS } from '#/features/tower/towerService';
import { towerKey, TowerInboxSent, type TowerInboxSentPayload } from '#/features/tower/towerOps';
import { TaskTerminatedNotice } from '#/agent/task/taskOps';
import { IAgentTaskService } from '#/agent/task/task';
import { SubagentStarted } from '#/session/subagent/mirrorAgentRun';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventBus, ISessionEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { BashParserService } from '#/app/bashParser/bashParserService';
import { IConfigService } from '#/app/config/config';
import { IFeatureManager } from '#/app/feature/featureManager';
import { IFlagService } from '#/app/flag/flag';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ITelemetryService } from '#/app/telemetry/telemetry';
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
  let telemetryTrack2: Mock<(event: string, properties?: unknown) => void>;
  let towerFlagOn: boolean;
  let addedTools: string[];
  let removedTools: string[];
  let activeTools: string[] | undefined;
  let policyInactiveTools: string[];
  let liveSessions: Map<string, { busy: boolean; pendingInteraction: SessionPendingInteraction; exit: Mock<() => Promise<void>>; title?: string; metadataReadFails?: boolean }>;
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
    telemetryTrack2 = vi.fn();
    ix.stub(ITelemetryService, { track2: telemetryTrack2 });
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
    await tower.exit();
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

    await tower.exit();
    expect(tower.isActive).toBe(false);
    await tower.enter();
    await tower.enter();
    expect(tower.isActive).toBe(true);

    expect(events).toEqual([{ type: 'agent.status.updated', towerMode: true }]);
  });

  it('offers non-waiting branch leases and always releases them', async () => {
    const tower = ix.get(IAgentTowerService);
    let release!: () => void;
    const running = tower.withBranchLease(
      'feat/leased',
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    expect(tower.isBranchLeased('feat/leased')).toBe(true);
    await expect(tower.withBranchLease('feat/leased', () => Promise.resolve())).rejects.toThrow(
      /not waiting/,
    );
    await tower.withBranchLease('feat/other', () => Promise.resolve());
    release();
    await running;
    expect(tower.isBranchLeased('feat/leased')).toBe(false);

    await expect(
      tower.withBranchLease('feat/leased', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(tower.isBranchLeased('feat/leased')).toBe(false);
  });

  it('tracks tower_mode_enter and tower_mode_exit on transitions only', async () => {
    const tower = ix.get(IAgentTowerService);

    await tower.enter();
    expect(telemetryTrack2).toHaveBeenCalledWith('tower_mode_enter', {
      outcome: 'entered',
      reason: undefined,
    });

    telemetryTrack2.mockClear();
    await tower.exit();
    expect(telemetryTrack2).toHaveBeenCalledWith('tower_mode_exit', { reason: 'user' });

    telemetryTrack2.mockClear();
    await tower.exit();
    expect(telemetryTrack2).not.toHaveBeenCalled();
  });

  it('enter(base) prepares the workspace base and records the session owner', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-base-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await execFileAsync('git', ['branch', 'develop'], { cwd: repo });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-base' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await tower.enter('develop');

      expect(tower.isActive).toBe(true);
      const state = await new TowerStore(repo).load();
      expect(state.base).toBe('develop');
      expect(state.sessionId).toBe('session-base');

      await tower.exit();
      expect(tower.isActive).toBe(false);
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

  it('enter(base) re-anchors the workspace while missions are open', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-reanchor-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await execFileAsync('git', ['branch', 'develop'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init('session-previous', 'main');
      await store.plan([{ title: 'engine', scope: ['src/engine/**'] }]);
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-next' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await tower.enter('develop');

      expect(tower.isActive).toBe(true);
      const state = await store.load();
      expect(state.base).toBe('develop');
      expect(state.missions).toHaveLength(1);
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
      const { stdout: branches } = await execFileAsync('git', ['branch', '--list', 'integration'], { cwd: repo });
      expect(branches.trim()).toBe('');
      expect(await new TowerStore(repo).isInitialized()).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('re-enter while active only prepares the base again and does not re-dispatch', async () => {
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

      await tower.enter('develop');
      expect(tower.isActive).toBe(true);
      expect((await new TowerStore(repo).load()).base).toBe('develop');

      await tower.enter('develop');
      await tower.enter();
      expect(tower.isActive).toBe(true);

      expect(events).toEqual([{ type: 'agent.status.updated', towerMode: true }]);
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
      const infos: { msg: string; payload?: unknown }[] = [];
      ix.stub(ILogService, {
        ...stubLog(),
        info: (msg: string, payload?: unknown) => {
          infos.push({ msg, payload });
        },
      });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-main' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

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

      const activityLog = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
      expect(activityLog).toContain(' died ');
      expect(activityLog).toContain('session=session-main');
      expect(activityLog).toContain(`pid=${String(process.pid)}`);

      const notice = infos.find((entry) => entry.msg === 'tower: marking roster agent died');
      expect(notice?.payload).toMatchObject({
        event: 'TaskTerminatedNotice',
        agentId: 'agent-w1',
        taskId: 'agent-dead1',
        status: 'failed',
        stopReason: 'provider blew up',
        sessionId: 'session-main',
        pid: process.pid,
      });
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
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

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
        .mockImplementation(function (this: TowerStore, agentId, status, reason, sessionId) {
          const pending = originalMarkDied.call(this, agentId, status, reason, sessionId);
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
        expect(markSpy).toHaveBeenCalledWith('agent-stranger', 'failed', undefined, 'session-main');
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
      const infos: { msg: string; payload?: unknown }[] = [];
      ix.stub(ILogService, {
        ...stubLog(),
        info: (msg: string, payload?: unknown) => {
          infos.push({ msg, payload });
        },
      });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-main' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      publishAsMain(ix, new SubagentStarted({ subagentId: 'agent-w1' }));

      await vi.waitFor(async () => {
        const state = await store.load();
        expect(state.roster.agents[0]?.diedAt).toBeUndefined();
      });
      const state = await store.load();
      expect(state.roster.agents[0]?.deathStatus).toBeUndefined();
      const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
      expect(log).toContain('revived');
      expect(log).toContain('session=session-main');
      expect(log).toContain(`pid=${String(process.pid)}`);

      const notice = infos.find((entry) => entry.msg === 'tower: clearing roster agent death mark');
      expect(notice?.payload).toMatchObject({
        event: 'SubagentStarted',
        agentId: 'agent-w1',
        sessionId: 'session-main',
        pid: process.pid,
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('does not record or clear deaths while tower mode is inactive', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-death-inactive-'));
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
      await store.markAgentDied('agent-w1', 'failed', 'provider blew up');
      const infos: { msg: string; payload?: unknown }[] = [];
      ix.stub(ILogService, {
        ...stubLog(),
        info: (msg: string, payload?: unknown) => {
          infos.push({ msg, payload });
        },
      });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-main' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);
      expect(tower.isActive).toBe(false);

      const markSpy = vi.spyOn(TowerStore.prototype, 'markAgentDied');
      const clearSpy = vi.spyOn(TowerStore.prototype, 'clearAgentDied');
      try {
        publishAsMain(
          ix,
          new TaskTerminatedNotice({
            agentId: 'main',
            info: {
              taskId: 'agent-dead2',
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
        publishAsMain(ix, new SubagentStarted({ subagentId: 'agent-w1' }));

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(markSpy).not.toHaveBeenCalled();
        expect(clearSpy).not.toHaveBeenCalled();
      } finally {
        markSpy.mockRestore();
        clearSpy.mockRestore();
      }
      const state = await store.load();
      expect(state.roster.agents[0]?.diedAt).toBeDefined();
      expect(infos.some((entry) => entry.msg.startsWith('tower:'))).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('leaves the roster untouched when another session owns the tower store', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-death-foreign-'));
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
      await store.registerAgent({
        name: 'w2',
        kind: 'worker',
        agentId: 'agent-w2',
        sessionId: 'session-main',
        spawnedAt: new Date().toISOString(),
      });
      const infos: { msg: string; payload?: unknown }[] = [];
      ix.stub(ILogService, {
        ...stubLog(),
        info: (msg: string, payload?: unknown) => {
          infos.push({ msg, payload });
        },
      });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-main' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);
      await tower.enter();
      expect(tower.isActive).toBe(true);

      const stateFile = store.abs(STATE_FILE);
      const owned = JSON.parse(await readFile(stateFile, 'utf8')) as TowerState;
      owned.sessionId = 'session-other';
      await writeFile(stateFile, `${JSON.stringify(owned, null, 2)}\n`);
      await store.markAgentDied('agent-w2', 'failed', 'provider blew up');

      publishAsMain(
        ix,
        new TaskTerminatedNotice({
          agentId: 'main',
          info: {
            taskId: 'agent-dead3',
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
      publishAsMain(ix, new SubagentStarted({ subagentId: 'agent-w2' }));

      await new Promise((resolve) => setTimeout(resolve, 20));
      const state = await store.load();
      expect(state.roster.agents[0]?.diedAt).toBeUndefined();
      expect(state.roster.agents[1]?.diedAt).toBeDefined();

      const activityLog = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
      expect(activityLog.split('\n').filter((line) => line.includes(' died '))).toHaveLength(1);
      expect(activityLog).not.toContain(' revived ');

      const skips = infos.filter((entry) => entry.msg.includes('skipping'));
      expect(skips.map((entry) => entry.msg)).toEqual([
        'tower: skipping roster agent death mark — tower store is owned by another session',
        'tower: skipping roster agent death clear — tower store is owned by another session',
      ]);
      expect(skips[0]?.payload).toMatchObject({
        event: 'TaskTerminatedNotice',
        agentId: 'agent-w1',
        sessionId: 'session-main',
        owner: 'session-other',
        pid: process.pid,
      });
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

  it('vetoes AgentSwarm while tower mode is active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const decision = await fire(hookContext([toolCall('AgentSwarm', 'call_swarm')]));

    expect(decision).toEqual({
      veto: {
        output: expect.stringContaining('AgentSwarm is not available while tower mode is active'),
        isError: true,
      },
    });
    expect(decision?.veto?.output).toContain('TowerSpawn');
    expect(decision?.veto?.output).toContain('mutually exclusive');
    expect(decision?.veto?.output).toContain('exit tower mode first');
    expect(permissionGateRan).toBe(false);
    expect(formatDenyMessage).toHaveBeenCalledTimes(1);
  });

  it('abstains on AgentSwarm while tower mode is inactive', async () => {
    ix.get(IAgentTowerService);

    const decision = await fire(hookContext([toolCall('AgentSwarm', 'call_swarm')]));

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

  function goalHookContext(
    toolName: 'CreateGoal' | 'UpdateGoal',
    args: Record<string, unknown>,
  ): ResolvedToolExecutionHookContext {
    const call = toolCall(toolName, `call_${toolName.toLowerCase()}`);
    return {
      turnId: 0,
      signal,
      toolCall: call,
      toolCalls: [call],
      args,
      execution: { approvalRule: toolName, execute: async () => ({ output: '' }) },
    };
  }

  it('vetoes CreateGoal while tower mode is active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const decision = await fire(goalHookContext('CreateGoal', { objective: 'x' }));

    expect(decision).toEqual({
      veto: {
        output: expect.stringContaining('CreateGoal is not available while tower mode is active'),
        isError: true,
      },
    });
    expect(decision?.veto?.output).toContain('mutually exclusive');
    expect(decision?.veto?.output).toContain('exit tower mode first');
    expect(permissionGateRan).toBe(false);
    expect(formatDenyMessage).toHaveBeenCalledTimes(1);
  });

  it('abstains on CreateGoal while tower mode is inactive', async () => {
    ix.get(IAgentTowerService);

    const decision = await fire(goalHookContext('CreateGoal', { objective: 'x' }));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });

  it('vetoes an UpdateGoal resume while tower mode is active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const decision = await fire(goalHookContext('UpdateGoal', { status: 'active' }));

    expect(decision).toEqual({
      veto: {
        output: expect.stringContaining(
          'Resuming a goal is not available while tower mode is active',
        ),
        isError: true,
      },
    });
    expect(decision?.veto?.output).toContain('exit tower mode first');
    expect(permissionGateRan).toBe(false);
    expect(formatDenyMessage).toHaveBeenCalledTimes(1);
  });

  it('abstains on an UpdateGoal complete while tower mode is active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const decision = await fire(goalHookContext('UpdateGoal', { status: 'complete' }));

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
  ): Mock<() => Promise<void>> {
    const exit = vi.fn(() => Promise.resolve());
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

  it('enter() awaits the outgoing owner\'s release before adopting the roster', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-takeover-order-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init('session-original');
      await store.registerAgent({
        name: 'worker-stale',
        agentId: 'agent-0',
        sessionId: 'session-original',
        kind: 'worker',
        spawnedAt: new Date().toISOString(),
      });

      let releaseResolve: (() => void) | undefined;
      const ownerExit = stubLiveSession('session-original');
      ownerExit.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseResolve = resolve;
          }),
      );
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const adoptSpy = vi.spyOn(TowerStore.prototype, 'adopt');
      try {
        const tower = ix.get(IAgentTowerService);
        const entered = tower.enter();

        await vi.waitFor(() => expect(ownerExit).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(adoptSpy).not.toHaveBeenCalled();

        releaseResolve!();
        await entered;

        expect(adoptSpy).toHaveBeenCalledTimes(1);
        expect(tower.isActive).toBe(true);
        const state = await store.load();
        expect(state.sessionId).toBe('session-fork');
        expect(state.roster.agents).toEqual([]);
      } finally {
        adoptSpy.mockRestore();
      }
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

  it('enter() refuses to activate when the roster adoption cannot be persisted', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-adopt-fail-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init('session-original');
      await writeFile(join(repo, '.tower/comms/state.json'), '{corrupted\n');

      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await expect(tower.enter()).rejects.toThrow(/failed to adopt the tower workspace roster/);
      expect(tower.isActive).toBe(false);
      expect(addedTools).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter() refuses to activate when the tower state is unreadable', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-state-unreadable-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init('session-original');
      await rm(join(repo, '.tower/comms/state.json'), { force: true });
      await mkdir(join(repo, '.tower/comms/state.json'));

      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await expect(tower.enter()).rejects.toThrow(/failed to adopt the tower workspace roster/);
      expect(tower.isActive).toBe(false);
      expect(addedTools).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter() retires the previous session\'s roster without requiring TowerInit', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-enter-roster-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init('session-original');
      await store.registerAgent({
        name: 'worker-stale',
        agentId: 'agent-0',
        sessionId: 'session-original',
        kind: 'worker',
        spawnedAt: new Date().toISOString(),
      });

      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await tower.enter();

      const state = await store.load();
      expect(state.sessionId).toBe('session-fork');
      expect(state.roster.agents).toEqual([]);
      const log = await store.recentLog(5);
      expect(
        log.some((line) => line.includes(' adopt ') && line.includes('session=session-fork')),
      ).toBe(true);
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
      await tower.exit();

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
      await store.adopt('session-third');

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
        await tower.exit();

        await vi.waitFor(() => expect(releaseSpy).toHaveBeenCalledWith('session-fork'));
        await releaseSettled;
        expect(tower.isActive).toBe(false);
        expect((await store.load()).sessionId).toBe('session-third');
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

  it('does not veto AgentSwarm while the tower flag is off, even with tower mode persisted active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();
    expect(tower.isActive).toBe(true);
    towerFlagOn = false;

    const decision = await fire(hookContext([toolCall('AgentSwarm', 'call_swarm')]));

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

    await tower.exit();
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

    await tower.exit();
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
    ix2.stub(ITelemetryService, { track2: () => {} });
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

    await tower.exit();

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
    ix2.stub(ITelemetryService, { track2: () => {} });
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
    ix2.stub(ITelemetryService, { track2: () => {} });
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
      ix2.stub(ITelemetryService, { track2: () => {} });
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

  it('keeps a replayed tower mode when the store owner session is gone — and adopts the workspace', async () => {
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
      const store = new TowerStore(repo);
      await store.init('session-original');
      await store.registerAgent({
        name: 'worker-stale',
        agentId: 'agent-0',
        sessionId: 'session-original',
        kind: 'worker',
        spawnedAt: new Date().toISOString(),
      });

      const ix2 = disposables.add(new TestInstantiationService());
      ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
      ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
      ix2.set(IEventBus, new SyncDescriptor(EventBusService));
      ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
      ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
      ix2.stub(ITelemetryService, { track2: () => {} });
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
      const state = await new TowerStore(repo).load();
      expect(state.sessionId).toBe('session-fork');
      expect(state.roster.agents).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('deactivates a replayed tower mode when the stale-owner adoption fails', async () => {
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

    const repo = await mkdtemp(join(tmpdir(), 'tower-fork-adopt-fail-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init('session-original');
      await store.registerAgent({
        name: 'worker-stale',
        agentId: 'agent-0',
        sessionId: 'session-original',
        kind: 'worker',
        spawnedAt: new Date().toISOString(),
      });

      const ix2 = disposables.add(new TestInstantiationService());
      ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
      ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
      ix2.set(IEventBus, new SyncDescriptor(EventBusService));
      ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
      ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
      ix2.stub(ITelemetryService, { track2: () => {} });
      ix2.stub(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID));
      ix2.stub(ILogService, stubLog());
      ix2.stub(ISessionManager, {
        get: () => undefined,
      } as unknown as ISessionManager);
      ix2.stub(ISessionContext, {
        cwd: repo,
        sessionId: 'session-fork',
      } as unknown as ISessionContext);
      ix2.stub(IAgentReminderService, createReminderStub());
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
      registerTestAgentWire(ix2, testWireScope('wire', 'tower-fork-adopt-fail-restore'), {
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

      const adoptSpy = vi
        .spyOn(TowerStore.prototype, 'adopt')
        .mockRejectedValue(new Error('EACCES: permission denied'));
      try {
        await restoreTestEventDispatcher(
          dispatcher,
          ix2.get(IAppendLogStore),
          testWireScope('wire', 'tower-fork-adopt-fail-restore'),
          records,
        );

        expect(restored.isActive).toBe(false);
        expect(restoredAdded).toEqual([]);
        expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: false });
        const state = await new TowerStore(repo).load();
        expect(state.sessionId).toBe('session-original');
      } finally {
        adoptSpy.mockRestore();
      }
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
      ix2.stub(ITelemetryService, { track2: () => {} });
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
    ix2.stub(ITelemetryService, { track2: () => {} });
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
    ix2.stub(ITelemetryService, { track2: () => {} });
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
    ix2.stub(ITelemetryService, { track2: () => {} });
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

    it('follows the latest roster entry when the agent id collides with a stale session registration', async () => {
      const file = join(repo, '.tower/comms/state.json');
      const state = JSON.parse(await readFile(file, 'utf8')) as {
        roster: { agents: Record<string, unknown>[] };
      };
      state.roster.agents.unshift({
        name: 'worker-stale',
        agentId: WORKER_AGENT_ID,
        kind: 'worker',
        missionId: 'M29',
        worktree: 'wt-29',
        branch: 'feat/stale',
        spawnedAt: '2026-09-13T08:00:00.000Z',
      });
      await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
      ix.get(IAgentTowerService);

      const decision = await fire(writeHookContext('Write', [`${worktree}/src/gemm.cpp`]));

      expect(decision).toBeUndefined();
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
      await store.plan([{ title: 'Build engine', scope: ['src/engine/**'] }]);
      await execFileAsync('git', ['branch', 'feat/build-engine'], { cwd: repo });
      await store.registerAgent({
        name: 'w1',
        kind: 'worker',
        agentId: 'agent-w1',
        sessionId: 'session-main',
        missionId: 'M1',
        spawnedAt: new Date().toISOString(),
      });
      await store.updateMission('tower', 'M1', { owner: 'w1' }, { silent: true });
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
        undefined as unknown as ISessionUsageService,
        { handleOf: () => undefined } as unknown as IAgentLifecycleService,
      );
      const result = await executeTool(tool, { turnId: 0, toolCallId: 'call_send', args: input, signal });
      expect(result.isError).toBeFalsy();
    }

    it('publishes an inbox event when a worker messages the tower', async () => {
      await sendAs('agent-w1', { to: 'tower', subject: 'need wider scope', body: 'x' });

      expect(sent).toEqual([{ from: 'w1', to: 'tower', subject: 'need wider scope' }]);
    });

    it('includes stored message references and mission metadata in the inbox event', async () => {
      let payload: TowerInboxSent | undefined;
      disposables.add(
        bus.subscribe(TowerInboxSent, (event) => {
          payload = event;
        }),
      );

      await sendAs('agent-w1', { to: 'tower', subject: 'digest me', body: 'x' });

      expect(payload?.messageId).toBeTruthy();
      expect(payload?.file).toBeTruthy();
      expect(payload?.sentAt).toBeTruthy();
      expect(payload?.missionId).toBe('M1');
      const raw = await readFile(join(repo, payload!.file!), 'utf8');
      expect(raw).toContain(payload!.messageId);
      expect(raw).toContain(payload!.sentAt);
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

    it('steers a non-clean review to its owner and wakes the tower without duplicate messages', async () => {
      const store = new TowerStore(repo);
      await store.registerAgent({
        name: 'r1',
        kind: 'reviewer',
        agentId: 'agent-r1',
        sessionId: 'session-main',
        reviewTarget: 'feat/build-engine',
        reviewMissionId: 'M1',
        spawnedAt: new Date().toISOString(),
      });
      const submissions: string[] = [];
      const lockStates: boolean[] = [];
      disposables.add(
        bus.subscribe(TowerInboxSent, () => {
          lockStates.push(existsSync(join(repo, `${STATE_FILE}.lock`)));
        }),
      );
      const ownerLoop = {
        snapshot: () => ({ state: 'running' }),
        submit: (entry: unknown) => {
          lockStates.push(existsSync(join(repo, `${STATE_FILE}.lock`)));
          submissions.push(JSON.stringify(entry));
        },
      };
      const tool = new TowerReviewTool(
        { cwd: repo } as unknown as ISessionContext,
        makeAgentScopeContext({ agentId: 'agent-r1', agentScope: testWireScope('wire', 'tower-test'), generation: 0 }),
        undefined as unknown as ISessionUsageService,
        bus,
        {
          list: () => {
            lockStates.push(existsSync(join(repo, `${STATE_FILE}.lock`)));
            return [];
          },
        } as unknown as IAgentTaskService,
        {
          handleOf: (agentId: string) =>
            agentId === 'agent-w1'
              ? {
                  accessor: {
                    get: (token: unknown) => (token === IAgentLoopService ? ownerLoop : undefined),
                  },
                }
              : undefined,
        } as unknown as IAgentLifecycleService,
      );

      const result = await executeTool(tool, {
        turnId: 0,
        toolCallId: 'call_review',
        args: {
          target: 'feat/build-engine',
          status: 'p1-1items',
          merge: 'hold',
          findings: 'problem',
          decision: 'fix it',
        },
        signal,
      });

      expect(result.isError).toBeFalsy();
      expect(result.output).toContain('notified: w1, tower');
      expect(submissions).toHaveLength(1);
      expect(submissions[0]).toContain('review-result');
      expect(sent).toEqual([{ from: 'r1', to: 'tower', subject: 'review-result' }]);
      const messages = await store.readInbox('tower', 20);
      expect(messages.filter((item) => item.subject === 'review-result')).toHaveLength(2);
      expect(messages.filter((item) => item.to === 'w1')).toHaveLength(1);
      expect(messages.filter((item) => item.to === 'tower')).toHaveLength(1);
      expect(lockStates.length).toBeGreaterThan(0);
      expect(lockStates).not.toContain(true);
    });

    it('wakes the tower for TowerComplete only after the state lock is released', async () => {
      await execFileAsync('git', ['checkout', 'feat/build-engine'], { cwd: repo });
      await mkdir(join(repo, 'src/engine'), { recursive: true });
      await writeFile(join(repo, 'src/engine/engine.ts'), 'export const engine = 1;\n');
      await execFileAsync('git', ['add', 'src/engine/engine.ts'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'engine work'], { cwd: repo });
      await execFileAsync('git', ['checkout', 'main'], { cwd: repo });
      const lockStates: boolean[] = [];
      disposables.add(
        bus.subscribe(TowerInboxSent, () => {
          lockStates.push(existsSync(join(repo, `${STATE_FILE}.lock`)));
        }),
      );
      const tool = new TowerCompleteTool(
        { cwd: repo } as unknown as ISessionContext,
        makeAgentScopeContext({ agentId: 'agent-w1', agentScope: testWireScope('wire', 'tower-test'), generation: 0 }),
        undefined as unknown as ISessionUsageService,
        bus,
        { list: () => [] } as unknown as IAgentTaskService,
        { handleOf: () => undefined } as unknown as IAgentLifecycleService,
      );

      const result = await executeTool(tool, {
        turnId: 0,
        toolCallId: 'call_complete',
        args: { report: 'completed the engine' },
        signal,
      });

      expect(result.isError).toBeFalsy();
      expect(result.output).toContain('mission M1 persisted as completed');
      expect(sent).toEqual([{ from: 'w1', to: 'tower', subject: 'review-request' }]);
      expect(lockStates).toEqual([false]);
      const store = new TowerStore(repo);
      expect((await store.load()).missions[0]?.status).toBe('completed');
      expect((await store.readInbox('tower', 20)).filter((item) => item.action === 'complete')).toHaveLength(1);
    });

    it('redelivers a reused completion message after an initial publish failure', async () => {
      await execFileAsync('git', ['checkout', 'feat/build-engine'], { cwd: repo });
      await mkdir(join(repo, 'src/engine'), { recursive: true });
      await writeFile(join(repo, 'src/engine/engine.ts'), 'export const engine = 1;\n');
      await execFileAsync('git', ['add', 'src/engine/engine.ts'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'engine work'], { cwd: repo });
      await execFileAsync('git', ['checkout', 'main'], { cwd: repo });
      const tool = new TowerCompleteTool(
        { cwd: repo } as unknown as ISessionContext,
        makeAgentScopeContext({ agentId: 'agent-w1', agentScope: testWireScope('wire', 'tower-test'), generation: 0 }),
        undefined as unknown as ISessionUsageService,
        bus,
        { list: () => [] } as unknown as IAgentTaskService,
        { handleOf: () => undefined } as unknown as IAgentLifecycleService,
      );
      const publish = vi.spyOn(bus, 'publish').mockImplementationOnce(() => {
        throw new Error('forced publish failure');
      });
      try {
        await expect(
          executeTool(tool, {
            turnId: 0,
            toolCallId: 'call_complete_publish',
            args: { report: 'completed after publish failure' },
            signal,
          }),
        ).rejects.toThrow('forced publish failure');
        const store = new TowerStore(repo);
        expect((await store.load()).missions[0]?.status).toBe('completed');
        expect((await store.readInbox('tower', 20)).filter((item) => item.action === 'complete')).toHaveLength(1);
        publish.mockRestore();

        const result = await executeTool(tool, {
          turnId: 0,
          toolCallId: 'call_complete_publish_retry',
          args: { report: 'completed after publish failure' },
          signal,
        });

        expect(result.isError).toBeFalsy();
        expect(result.output).toContain('reused the stored message');
        expect(sent).toEqual([{ from: 'w1', to: 'tower', subject: 'review-request' }]);
        expect((await store.readInbox('tower', 20)).filter((item) => item.action === 'complete')).toHaveLength(1);
      } finally {
        publish.mockRestore();
      }
    });
  });

  describe('inbox wake', () => {
    let loop: StubLoop;

    beforeEach(() => {
      loop = stubLoopWithHooks();
      ix.stub(IAgentLoopService, loop);
      ix.stub(ISessionEventBus, ix.get(IEventBus) as ISessionEventBus);
    });

    function publishInbox(input: TowerInboxSentPayload): void {
      ix.get(IEventBus).publish(new TowerInboxSent(input));
    }

    async function flushWake(): Promise<void> {
      for (let i = 0; i < 50 && !loop.queue.hasPendingRequests(); i++) {
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }
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

    it('warns in the wake text when the tower state was recovered after a loss', async () => {
      const repo = await mkdtemp(join(tmpdir(), 'tower-wake-recovered-'));
      try {
        await initGitRepo(repo);
        await writeFile(join(repo, 'README.md'), '# fixture\n');
        await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
        const store = new TowerStore(repo);
        await store.init('session-wake');
        const statePath = join(repo, '.tower/comms/state.json');
        const stored = JSON.parse(await readFile(statePath, 'utf8')) as TowerState;
        await writeFile(
          statePath,
          JSON.stringify({ ...stored, recoveredAt: '2026-10-03T00:00:00.000Z' }),
        );

        ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-wake' } as unknown as ISessionContext);
        const tower = ix.get(IAgentTowerService);
        await tower.enter();

        publishInbox({ from: 'w1', to: 'tower', subject: 'after loss' });
        await flushWake();
        const messages = drainWakeMessages();

        expect(messages).toHaveLength(1);
        const text = wakeText(messages[0]!);
        expect(text).toContain('recovered after a loss at 2026-10-03T00:00:00.000Z');
        expect(text).toContain('Report the loss to the user');
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
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

    it('queues consecutive legacy events with the same sender and subject independently', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      publishInbox({ from: 'w1', to: 'tower', subject: 'same legacy subject' });
      publishInbox({ from: 'w1', to: 'tower', subject: 'same legacy subject' });
      await flushWake();
      const messages = drainWakeMessages();

      expect(messages).toHaveLength(1);
      const text = wakeText(messages[0]!);
      expect(text).toContain('2 new tower inbox messages');
      expect(text.match(/- w1: "same legacy subject"/g)).toHaveLength(2);
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

    it('deduplicates a burst and bounds references while preserving the omitted count', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      for (let index = 1; index <= 8; index += 1) {
        publishInbox({
          from: 'w1',
          to: 'tower',
          subject: `subject-${String(index)}`,
          messageId: `msg-${String(index)}`,
        });
      }
      publishInbox({ from: 'w1', to: 'tower', subject: 'duplicate', messageId: 'msg-1' });
      await flushWake();
      const messages = drainWakeMessages();

      expect(messages).toHaveLength(1);
      const text = wakeText(messages[0]!);
      expect(text).toContain('8 new tower inbox messages');
      expect(text).toContain('omitted=2');
      expect(text).not.toContain('messageId=msg-1\n');
      expect(text).not.toContain('messageId=msg-2\n');
      expect(text).toContain('messageId=msg-3');
      expect(text).toContain('messageId=msg-8');
    });

    it('still wakes with message references when gate observation fails', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      publishInbox({
        from: 'w1',
        to: 'tower',
        subject: 'needs review',
        messageId: 'msg-observation',
        file: '.tower/comms/inbox/needs-review.md',
        missionId: 'M1',
      });
      await flushWake();
      await vi.waitFor(() => {
        expect(loop.snapshot().hasPendingRequests).toBe(true);
      });
      const messages = drainWakeMessages();

      expect(messages).toHaveLength(1);
      const text = wakeText(messages[0]!);
      expect(text).toContain('messageId=msg-observation');
      expect(text).toContain('M1: gate=unavailable');
      expect(text).toContain('TowerInbox');
    });

    it('includes message references and computes each related mission gate once', async () => {
      const repo = await mkdtemp(join(tmpdir(), 'tower-wake-digest-'));
      const gate = vi.spyOn(TowerStore.prototype, 'missionGate');
      try {
        await initGitRepo(repo);
        await writeFile(join(repo, 'README.md'), '# fixture\n');
        await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
        const store = new TowerStore(repo);
        await store.init('session-main');
        await store.plan([
          { title: 'first mission', scope: ['src/first/**'] },
          { title: 'second mission', scope: ['src/second/**'] },
        ]);
        ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-main' } as unknown as ISessionContext);
        ix.stub(IAgentTaskService, { list: () => [] } as unknown as IAgentTaskService);
        const tower = ix.get(IAgentTowerService);
        await tower.enter();

        publishInbox({
          from: 'w1',
          to: 'tower',
          subject: 'first update',
          messageId: 'msg-digest-1',
          file: '.tower/comms/inbox/first.md',
          sentAt: '2026-09-30T00:00:00.000Z',
          missionId: 'M1',
        });
        publishInbox({
          from: 'w1',
          to: 'tower',
          subject: 'second update',
          messageId: 'msg-digest-2',
          file: '.tower/comms/inbox/second.md',
          sentAt: '2026-09-30T00:00:01.000Z',
          missionId: 'M1',
        });
        publishInbox({
          from: 'w2',
          to: 'all',
          subject: 'third update',
          messageId: 'msg-digest-3',
          file: '.tower/comms/inbox/third.md',
          sentAt: '2026-09-30T00:00:02.000Z',
          missionId: 'M2',
        });
        await flushWake();
        await vi.waitFor(() => {
          expect(loop.snapshot().hasPendingRequests).toBe(true);
        });
        const messages = drainWakeMessages();

        expect(messages).toHaveLength(1);
        const text = wakeText(messages[0]!);
        expect(text).toContain('messageId=msg-digest-1');
        expect(text).toContain('file=.tower/comms/inbox/first.md');
        expect(text).toContain('sentAt=2026-09-30T00:00:00.000Z');
        expect(text).toContain('mission=M1');
        expect(text).toContain('M1: gate=BLOCKED reasons=not-completed');
        expect(text).toContain('M2: gate=BLOCKED reasons=not-completed');
        expect(gate.mock.calls.filter(([, mission]) => mission.id === 'M1')).toHaveLength(1);
        expect(gate.mock.calls.filter(([, mission]) => mission.id === 'M2')).toHaveLength(1);
        expect(gate.mock.calls[0]?.[2]?.activeAgentIds).toEqual(new Set());
      } finally {
        gate.mockRestore();
        await rm(repo, { recursive: true, force: true });
      }
    });

    it('does not notify a stale flush after exit and re-entry while gate evaluation is deferred', async () => {
      const repo = await mkdtemp(join(tmpdir(), 'tower-wake-epoch-'));
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gate = vi.spyOn(TowerStore.prototype, 'missionGate').mockImplementationOnce(async () => {
        await pending;
        return { ready: false, blocks: [], observations: {} } as never;
      });
      try {
        await initGitRepo(repo);
        await writeFile(join(repo, 'README.md'), '# fixture\n');
        await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
        const store = new TowerStore(repo);
        await store.init('session-main');
        await store.plan([{ title: 'deferred mission', scope: ['src/deferred/**'] }]);
        ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-main' } as unknown as ISessionContext);
        ix.stub(IAgentTaskService, { list: () => [] } as unknown as IAgentTaskService);
        const tower = ix.get(IAgentTowerService);
        await tower.enter();
        publishInbox({
          from: 'w1',
          to: 'tower',
          subject: 'old flush',
          messageId: 'msg-old-flush',
          missionId: 'M1',
        });
        await vi.waitFor(() => {
          expect(gate).toHaveBeenCalled();
        });

        await tower.exit();
        await tower.enter();
        release();
        await flushWake();
        expect(drainWakeMessages()).toEqual([]);

        publishInbox({ from: 'w1', to: 'tower', subject: 'new flush', messageId: 'msg-new-flush' });
        await flushWake();
        const messages = drainWakeMessages();
        expect(messages).toHaveLength(1);
        expect(wakeText(messages[0]!)).toContain('messageId=msg-new-flush');
        expect(wakeText(messages[0]!)).not.toContain('messageId=msg-old-flush');
      } finally {
        release();
        gate.mockRestore();
        await rm(repo, { recursive: true, force: true });
      }
    });

    it('ignores messages addressed to a specific agent and messages from the tower itself', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      publishInbox({ from: 'w1', to: 'w2', subject: 'direct' });
      publishInbox({ from: 'tower', to: 'all', subject: 'self broadcast' });
      await flushWake();

      expect(drainWakeMessages()).toEqual([]);
      expect(loop.snapshot().hasPendingRequests).toBe(false);
    });

    it('does not wake while tower mode is inactive', async () => {
      ix.get(IAgentTowerService);

      publishInbox({ from: 'w1', to: 'tower', subject: 'hello' });
      await flushWake();

      expect(drainWakeMessages()).toEqual([]);
      expect(loop.snapshot().hasPendingRequests).toBe(false);
    });

    it('drops a queued wake when tower mode exits before it is consumed', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      publishInbox({ from: 'w1', to: 'tower', subject: 'need wider scope' });
      await flushWake();
      expect(loop.snapshot().hasPendingRequests).toBe(true);

      await tower.exit();

      expect(loop.snapshot().hasPendingRequests).toBe(false);
      expect(drainWakeMessages()).toEqual([]);
    });

    it('drops a queued wake when the tower becomes unavailable at runtime', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      publishInbox({ from: 'w1', to: 'tower', subject: 'need wider scope' });
      await flushWake();
      expect(loop.snapshot().hasPendingRequests).toBe(true);

      _setTowerFeatureAssembledForTests(false);
      try {
        fireUnitsChanged();

        expect(loop.snapshot().hasPendingRequests).toBe(false);
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
      expect(loop.snapshot().hasPendingRequests).toBe(false);
    });

    function publishUserPrompt(promptId: string): void {
      publishAsMain(
        ix,
        new PromptSubmitted({
          agentId: 'main',
          promptId,
          userMessageId: promptId,
          status: 'queued',
          content: [{ type: 'text', text: 'hold on' }],
          createdAt: new Date().toISOString(),
        }),
      );
    }

    it('cancels the inbox wake turn when a user prompt is submitted', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      const wakeTurn = loop.startTurn();
      publishAsMain(
        ix,
        new TurnStarted({
          agentId: 'main',
          turnId: wakeTurn.id,
          origin: { kind: 'injection', variant: TOWER_INBOX_WAKE_VARIANT },
        }),
      );
      publishUserPrompt('p1');
      await flushWake();

      expect(loop.cancels).toHaveLength(1);
      expect(loop.cancels[0]?.turnId).toBe(wakeTurn.id);
      expect(isUserCancellation(loop.cancels[0]?.reason)).toBe(true);
    });

    it('ignores turns seeded by other notification origins', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      const cronTurn = loop.startTurn();
      publishAsMain(
        ix,
        new TurnStarted({
          agentId: 'main',
          turnId: cronTurn.id,
          origin: { kind: 'injection', variant: 'cron' },
        }),
      );
      publishUserPrompt('p1');
      await flushWake();

      expect(loop.cancels).toEqual([]);
    });

    it('does not cancel after the wake turn has already ended', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      const wakeTurn = loop.startTurn();
      publishAsMain(
        ix,
        new TurnStarted({
          agentId: 'main',
          turnId: wakeTurn.id,
          origin: { kind: 'injection', variant: TOWER_INBOX_WAKE_VARIANT },
        }),
      );
      publishAsMain(ix, new TurnEnded({ agentId: 'main', turnId: wakeTurn.id, reason: 'completed' }));
      publishUserPrompt('p1');
      await flushWake();

      expect(loop.cancels).toEqual([]);
    });

    it('re-arms the inbox wake after the interrupting user turn ends', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      publishInbox({
        from: 'w1',
        to: 'tower',
        subject: 'need review',
        messageId: 'msg-rearm',
        file: '.tower/comms/inbox/rearm.md',
      });
      await flushWake();
      expect(drainWakeMessages()).toHaveLength(1);

      const wakeTurn = loop.startTurn();
      publishAsMain(
        ix,
        new TurnStarted({
          agentId: 'main',
          turnId: wakeTurn.id,
          origin: { kind: 'injection', variant: TOWER_INBOX_WAKE_VARIANT },
        }),
      );
      publishUserPrompt('p1');
      await flushWake();
      expect(loop.cancels).toHaveLength(1);

      publishAsMain(ix, new TurnEnded({ agentId: 'main', turnId: wakeTurn.id, reason: 'cancelled' }));
      publishAsMain(ix, new TurnEnded({ agentId: 'main', turnId: 99, reason: 'completed' }));
      await flushWake();

      const rearmed = drainWakeMessages();
      expect(rearmed).toHaveLength(1);
      expect(wakeText(rearmed[0]!)).toContain('1 new tower inbox message');
      expect(wakeText(rearmed[0]!)).toContain('w1');
      expect(wakeText(rearmed[0]!)).toContain('messageId=msg-rearm');
      expect(wakeText(rearmed[0]!)).toContain('file=.tower/comms/inbox/rearm.md');
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
        branch: 'feat/leased',
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

    it('vetoes even a background resume while its branch is leased', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      await tower.withBranchLease('feat/leased', async () => {
        const decision = await fire(
          agentHookContext({
            resume: 'agent-w1',
            run_in_background: true,
            prompt: 'keep going',
            description: 'resume w1',
          }),
        );
        expect(decision?.veto?.isError).toBe(true);
        expect(decision?.veto?.output).toContain('leased by a merge/rebase');
        expect(decision?.veto?.output).toContain('no agent was started');
      });

      expect(permissionGateRan).toBe(false);
      expect(formatDenyMessage).toHaveBeenCalledTimes(1);
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

    async function useReviewer(): Promise<void> {
      const store = new TowerStore(repo);
      await store.registerAgent({
        name: 'r1',
        kind: 'reviewer',
        agentId: 'agent-r1',
        sessionId: 'session-main',
        reviewTarget: 'feat/leased',
        reviewMissionId: 'M1',
        spawnedAt: new Date().toISOString(),
      });
      ix.stub(
        IAgentScopeContext,
        makeAgentScopeContext({
          agentId: 'agent-r1',
          agentScope: testWireScope('wire', 'tower-test'),
          generation: 0,
        }),
      );
      ix.get(IAgentTowerService);
    }

    it.each([
      ['main', false],
      ['main', true],
      ['agent-w1', false],
      ['agent-w1', true],
    ])('vetoes reviewer resume of %s with run_in_background=%s', async (resumeId, background) => {
      await useReviewer();

      const decision = await fire(
        agentHookContext({
          resume: resumeId,
          run_in_background: background,
          prompt: 'review again',
          description: 'forbidden reviewer resume',
        }),
      );

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('Reviewer agents cannot resume');
      expect(decision?.veto?.output).toContain('Non-roster explore/plan subagents are still allowed');
      expect(permissionGateRan).toBe(false);
    });

    it('allows a reviewer to resume a non-roster agent', async () => {
      await useReviewer();

      const decision = await fire(
        agentHookContext({
          resume: 'agent-stranger',
          run_in_background: true,
          prompt: 'keep exploring',
          description: 'non-roster resume',
        }),
      );

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
    });

    it.each(['explore', 'plan'])('allows a fresh non-roster %s subagent for a reviewer', async (type) => {
      await useReviewer();

      const decision = await fire(
        agentHookContext({
          subagent_type: type,
          prompt: 'inspect the branch',
          description: 'fresh analysis',
        }),
      );

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
    });
  });
  describe('bash destructive guard', () => {
    let repo: string;
    let slot: string;

    beforeEach(async () => {
      repo = await mkdtemp(join(tmpdir(), 'tower-bash-guard-'));
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await new TowerStore(repo).init('session-main');
      slot = join(repo, '.tower', 'worktrees', 'wt-1');
      await mkdir(slot, { recursive: true });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-main' } as unknown as ISessionContext);
      ix.stub(IBashParserService, new BashParserService());
    });

    afterEach(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    function bashHookContext(command: string, cwd?: string): ResolvedToolExecutionHookContext {
      const call = toolCall('Bash', 'call_bash');
      return {
        turnId: 0,
        signal,
        toolCall: call,
        toolCalls: [call],
        args: cwd === undefined ? { command } : { command, cwd },
        execution: { approvalRule: 'Bash', execute: async () => ({ output: '' }) },
      };
    }

    it.each([
      'git clean -fdx',
      'git clean -ffdx',
      'git clean -f -d -x',
      'git clean --force -dx',
      'git clean -fdx .',
      'git clean -fdx .tower',
      'git clean -fdx -- .tower/comms',
      'git clean -fdx .tower/comms/state.json',
    ])('vetoes "%s" at the main checkout without tower mode active (worker shape)', async (command) => {
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext(command));

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('.tower/comms');
      expect(decision?.veto?.output).toContain('worktree');
      expect(permissionGateRan).toBe(false);
      expect(formatDenyMessage).toHaveBeenCalledTimes(1);
    });

    it('vetoes git clean at the main checkout while tower mode is active (main agent shape)', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.enter();

      const decision = await fire(bashHookContext('git clean -fdx'));

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('.tower/comms');
      expect(permissionGateRan).toBe(false);
    });

    it('vetoes git clean targeting the main checkout from outside via git -C', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext(`git -C ${repo} clean -fdx`, tmpdir()));

      expect(decision?.veto?.isError).toBe(true);
      expect(permissionGateRan).toBe(false);
    });

    it.each([
      'git clean -ndx',
      'git clean -n',
      'git clean --dry-run -fdx',
      'git clean -fdxn',
      'git clean -f',
      'git clean -fdx packages',
    ])('allows "%s" (dry-run, files-only, or out-of-scope pathspec)', async (command) => {
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext(command));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('allows git clean and git reset --hard inside a tower worktree', async () => {
      ix.get(IAgentTowerService);

      for (const command of [
        `cd ${slot} && git clean -fdx`,
        `cd ${slot} && git clean -fdx .`,
        `cd ${slot} && git clean -fdx ./`,
        `cd ${slot} && git clean -fdx -- .`,
        `cd ${slot} && git clean -fdx node_modules`,
        `cd ${join(slot, 'pkg')} && git clean -fdx ..`,
        `git -C ${slot} clean -fdx`,
        `git -C ${slot} clean -fdx .`,
        `cd ${slot} && git reset --hard`,
        `git -C ${slot} reset --hard HEAD~1`,
      ]) {
        const decision = await fire(bashHookContext(command));

        expect(decision, command).toBeUndefined();
      }
      expect(permissionGateRan).toBe(true);
    });

    it('allows git clean with a dot pathspec in a worktree via the Bash cwd argument', async () => {
      ix.get(IAgentTowerService);

      for (const command of ['git clean -fdx', 'git clean -fdx .', 'git clean -fdx -- .']) {
        const decision = await fire(bashHookContext(command, slot));

        expect(decision, command).toBeUndefined();
      }
      expect(permissionGateRan).toBe(true);
    });

    it('still vetoes git clean naming a worktree slot root from the main checkout', async () => {
      ix.get(IAgentTowerService);

      for (const command of [
        'git clean -fdx .tower/worktrees/wt-1',
        'git clean -ffdx .tower/worktrees/wt-1',
        `git clean -fdx ${slot}`,
      ]) {
        const decision = await fire(bashHookContext(command));

        expect(decision?.veto?.isError, command).toBe(true);
      }
    });

    it('still vetoes git clean whose pathspec escapes a worktree slot into tower protocol paths', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext(`cd ${slot} && git clean -fdx ../../comms`));

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('.tower/comms');
    });

    it.each([
      'git reset --hard',
      'git reset --hard HEAD~1',
      'git reset --hard origin/main',
    ])('vetoes "%s" at the main checkout', async (command) => {
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext(command));

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('git reset --hard');
      expect(decision?.veto?.output).toContain('worktree');
      expect(permissionGateRan).toBe(false);
    });

    it.each(['git reset', 'git reset --soft HEAD~1', 'git reset --mixed'])(
      'allows "%s" without --hard',
      async (command) => {
        ix.get(IAgentTowerService);

        const decision = await fire(bashHookContext(command));

        expect(decision).toBeUndefined();
        expect(permissionGateRan).toBe(true);
      },
    );

    it('vetoes git -C reset --hard whose target is the main checkout even from a worktree cwd', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext(`git -C ${repo} reset --hard`, slot));

      expect(decision?.veto?.isError).toBe(true);
      expect(permissionGateRan).toBe(false);
    });

    it.each([
      'rm -rf .tower',
      'rm -rf .tower/comms',
      'rm -f .tower/comms/state.json',
      'rm --recursive --force .tower',
      'rm -rf .tower/worktrees',
    ])('vetoes "%s" on tower protocol paths', async (command) => {
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext(command));

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('.tower/comms');
      expect(permissionGateRan).toBe(false);
    });

    it('vetoes recursive rm of the main checkout root (an ancestor of .tower)', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext(`rm -rf ${repo}`));

      expect(decision?.veto?.isError).toBe(true);
      expect(permissionGateRan).toBe(false);
    });

    it.each([
      'rm -rf node_modules',
      'rm -f README.md',
      'rm -rf .tmp',
    ])('allows "%s" on ordinary main-checkout paths', async (command) => {
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext(command));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
    });

    it('allows rm -rf inside a worktree slot', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext(`rm -rf ${join(slot, 'node_modules')}`));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
    });

    it('tracks cd chains across && lists', async () => {
      ix.get(IAgentTowerService);

      const allowed = await fire(bashHookContext('cd packages && git clean -fdx'));
      const vetoed = await fire(bashHookContext('cd packages && cd .. && git clean -fdx'));

      expect(allowed).toBeUndefined();
      expect(vetoed?.veto?.isError).toBe(true);
    });

    it.each([
      "bash -c 'git clean -fdx'",
      'sudo rm -rf .tower',
      'env FOO=1 git reset --hard',
      'eval "git clean -fdx"',
    ])('vetoes "%s" through wrappers and nested shells', async (command) => {
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext(command));

      expect(decision?.veto?.isError).toBe(true);
      expect(permissionGateRan).toBe(false);
    });

    it('allows a command that only mentions the keywords in string literals', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext('echo "git clean -fdx" && printf "rm -rf"'));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('passes commands without dangerous keywords with zero parse cost', async () => {
      const parse = vi.fn();
      ix.stub(IBashParserService, { parse } as unknown as IBashParserService);
      ix.get(IAgentTowerService);

      const first = await fire(bashHookContext('ls -la && git status'));
      const second = await fire(bashHookContext('echo format armory cleanup resetting'));

      expect(first).toBeUndefined();
      expect(second).toBeUndefined();
      expect(parse).not.toHaveBeenCalled();
    });

    it('allows dangerous-shaped commands when no tower state exists, without parsing', async () => {
      const plain = await mkdtemp(join(tmpdir(), 'tower-bash-guard-plain-'));
      try {
        ix.stub(ISessionContext, { cwd: plain, sessionId: 'session-plain' } as unknown as ISessionContext);
        const parse = vi.fn();
        ix.stub(IBashParserService, { parse } as unknown as IBashParserService);
        ix.get(IAgentTowerService);

        const decision = await fire(bashHookContext('git clean -fdx'));

        expect(decision).toBeUndefined();
        expect(parse).not.toHaveBeenCalled();
      } finally {
        await rm(plain, { recursive: true, force: true });
      }
    });

    it('vetoes conservatively when the command cannot be parsed', async () => {
      const parse = vi.fn(() => ({ ok: false as const, reason: 'aborted' as const }));
      ix.stub(IBashParserService, { parse } as unknown as IBashParserService);
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext('git clean -fdx'));

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('could not parse');
      expect(permissionGateRan).toBe(false);
    });

    it('vetoes conservatively when the parsed tree carries errors', async () => {
      const root = {
        type: 'program',
        text: 'git clean -fdx',
        startIndex: 0,
        endIndex: 'git clean -fdx'.length,
        isNamed: true,
        children: [],
      };
      const parse = vi.fn(() => ({ ok: true as const, hasError: true, root }));
      ix.stub(IBashParserService, { parse } as unknown as IBashParserService);
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext('git clean -fdx'));

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('could not parse');
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
    expect(text).toContain('message references and a compact gate digest');
    expect(text).toContain('with `TowerInbox` only when it is needed');
    expect(text).toContain('structured reason and recovery details');
    expect(text).toContain('per reviewer');
    expect(text).toContain('merged or abandoned');
    expect(text).toContain('background execution is unavailable');
    expect(text).toContain('break-glass');
    expect(text).toContain('.tower/comms/');
    expect(text).not.toContain('This supersedes any other instructions');
    expect(text).not.toContain('never create or edit files under `.tower/` by hand');
  });

  it('injects the exit reminder when tower mode turns off after being active', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    await tower.exit();
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

  it('does not refresh the full reminder for an internal injection user-role message', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    appendAssistantTurn(ctx, context, 'assistant one');
    ctx.appendSystemReminder('inbox wake', { kind: 'injection', variant: 'tower_inbox' });
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(1);
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
    await tower.exit();
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
