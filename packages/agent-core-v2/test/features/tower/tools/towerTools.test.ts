import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { userCancellationReason } from '#/_base/utils/abort';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService, type AgentTaskInfo } from '#/agent/task/task';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { AnyAgentTool } from '#/agent/toolRegistry/toolContribution';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { TOWER_TOOL_CONTRIBUTIONS } from '#/features/tower/towerFeature';
import { IAgentTowerService } from '#/features/tower/tower';
import { ITowerRateLimitService } from '#/features/tower/towerRateLimit';
import { TowerStore, parseFrontmatter } from '#/features/tower/protocol/index';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import type { ExecutableTool } from '#/tool/toolContract';
import type { TokenUsage } from '#human/llm/usage';

import { ITowerInitTool } from '#/features/tower/tools/init/init';
import { TowerInitTool } from '#/features/tower/tools/init/initTool';
import { ITowerPlanTool } from '#/features/tower/tools/plan/plan';
import { TowerPlanTool } from '#/features/tower/tools/plan/planTool';
import { ITowerMergeTool } from '#/features/tower/tools/merge/merge';
import { TowerMergeTool } from '#/features/tower/tools/merge/mergeTool';
import { ITowerRebaseTool } from '#/features/tower/tools/rebase/rebase';
import { TowerRebaseTool } from '#/features/tower/tools/rebase/rebaseTool';
import { ITowerCompleteTool } from '#/features/tower/tools/complete/complete';
import { TowerCompleteTool } from '#/features/tower/tools/complete/completeTool';
import { ITowerTeardownTool } from '#/features/tower/tools/teardown/teardown';
import { TowerTeardownTool } from '#/features/tower/tools/teardown/teardownTool';
import { ITowerSendTool } from '#/features/tower/tools/send/send';
import { TowerSendTool } from '#/features/tower/tools/send/sendTool';
import { ITowerInboxTool } from '#/features/tower/tools/inbox/inbox';
import { TowerInboxTool } from '#/features/tower/tools/inbox/inboxTool';
import { ITowerFindingTool } from '#/features/tower/tools/finding/finding';
import { TowerFindingTool } from '#/features/tower/tools/finding/findingTool';
import { ITowerReviewTool } from '#/features/tower/tools/review/review';
import { TowerReviewTool } from '#/features/tower/tools/review/reviewTool';
import { ITowerMissionTool } from '#/features/tower/tools/mission/mission';
import { TowerMissionTool } from '#/features/tower/tools/mission/missionTool';
import { ITowerStatusTool } from '#/features/tower/tools/status/status';
import { readTowerStatus, readTowerStatusSummary } from '#/features/tower/tools/status/statusReader';
import { TowerStatusTool } from '#/features/tower/tools/status/statusTool';

import { executeTool } from '../../../tools/fixtures/execute-tool';
import { stubAgentContext } from '../../../agent/agentContext/stubs';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { TOWER_MODE_USER_ENABLED_ONLY } from '#/features/tower/tools/support';

const execFileAsync = promisify(execFile);
const signal = new AbortController().signal;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function commitFile(
  cwd: string,
  rel: string,
  content: string,
  message: string,
): Promise<void> {
  const abs = join(cwd, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  await git(cwd, 'add', rel);
  await git(cwd, 'commit', '-m', message);
}

let repo: string;
let disposables: DisposableStore;
let ix: TestInstantiationService;
let towerActive: boolean;
let currentAgentId: string;
let currentSessionId: string;
let liveSessionIds: string[];
let liveAgentTaskIds: string[];
let usageTotal: TokenUsage | undefined;
const agentContexts = new Map<string, AgentContext>();
const agentLoops = new Map<string, { state: 'idle' | 'running'; submitted: string[] }>();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'tower-tools-test-'));
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'tower-test@example.com');
  await git(repo, 'config', 'user.name', 'Tower Test');
  await commitFile(repo, 'README.md', '# fixture\n', 'initial');

  towerActive = false;
  currentAgentId = 'main';
  liveSessionIds = [];
  liveAgentTaskIds = [];
  usageTotal = undefined;
  currentSessionId = 'session-test';
  agentContexts.clear();
  agentLoops.clear();

  disposables = new DisposableStore();
  ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.defineInstance(ISessionContext, {
        _serviceBrand: undefined,
        get sessionId() {
          return currentSessionId;
        },
        workspaceId: 'workspace-test',
        sessionDir: join(repo, '.session'),
        metaScope: 'sessions/test',
        cwd: repo,
        scope: (subKey?: string) =>
          subKey === undefined || subKey === '' ? 'sessions/test' : `sessions/test/${subKey}`,
      });
      reg.defineInstance(IAgentScopeContext, {
        _serviceBrand: undefined,
        get agentId() {
          return currentAgentId;
        },
        get agentContext() {
          let context = agentContexts.get(currentAgentId);
          if (context === undefined) {
            context = stubAgentContext(currentAgentId, 0);
            agentContexts.set(currentAgentId, context);
          }
          return context;
        },
        scope: (subKey?: string) => subKey ?? '',
      });
      reg.defineInstance(IAgentTowerService, {
        _serviceBrand: undefined,
        get isActive() {
          return towerActive;
        },
        enter: () => {
          towerActive = true;
          return Promise.resolve({ entered: true as const });
        },
        exit: () => {
          towerActive = false;
          return Promise.resolve();
        },
        isBranchLeased: () => false,
        withBranchLease: <T>(_branch: string, execute: () => Promise<T>) => execute(),
      });
      reg.defineInstance(ISessionManager, {
        get: (id: string) => (liveSessionIds.includes(id) ? {} : undefined),
      } as unknown as ISessionManager);
      reg.definePartialInstance(ITowerRateLimitService, {
        snapshot: () => ({ budget: 2, inflight: 0, blockedUntil: null }),
      });
      reg.definePartialInstance(ISessionUsageService, {
        status: () => ({ total: usageTotal }),
      });
      reg.definePartialInstance(IAgentTaskService, {
        list: () =>
          liveAgentTaskIds.map(
            (agentId) => ({ kind: 'agent', agentId }) as unknown as AgentTaskInfo,
          ),
      });
      reg.definePartialInstance(IAgentLifecycleService, {
        handleOf: ((agentId: string) => {
          const loop = agentLoops.get(agentId);
          if (loop === undefined) return undefined;
          return {
            accessor: {
              get: (token: unknown) =>
                token === IAgentLoopService
                  ? {
                      snapshot: () => ({ state: loop.state }),
                      submit: (entry: unknown) => {
                        const text = (entry as { message: { content: { text: string }[] } })
                          .message.content[0]!.text;
                        loop.submitted.push(text);
                        return { id: 'prompt-1' };
                      },
                    }
                  : undefined,
            },
          };
        }) as unknown as IAgentLifecycleService['handleOf'],
      });
      reg.define(ITowerInitTool, TowerInitTool);
      reg.define(ITowerPlanTool, TowerPlanTool);
      reg.define(ITowerMergeTool, TowerMergeTool);
      reg.define(ITowerRebaseTool, TowerRebaseTool);
      reg.define(ITowerTeardownTool, TowerTeardownTool);
      reg.define(ITowerCompleteTool, TowerCompleteTool);
      reg.define(ITowerSendTool, TowerSendTool);
      reg.define(ITowerInboxTool, TowerInboxTool);
      reg.define(ITowerFindingTool, TowerFindingTool);
      reg.define(ITowerReviewTool, TowerReviewTool);
      reg.define(ITowerMissionTool, TowerMissionTool);
      reg.define(ITowerStatusTool, TowerStatusTool);
    },
  });
});

afterEach(async () => {
  disposables.dispose();
  await rm(repo, { recursive: true, force: true });
});

async function run<Input>(tool: ExecutableTool<Input>, args: Input) {
  return executeTool(tool, { turnId: 0, toolCallId: 'call_1', args, signal });
}

async function initViaTool() {
  towerActive = true;
  const result = await run(ix.get(ITowerInitTool), {});
  expect(result.isError).toBeFalsy();
  return result;
}

function readStatus() {
  return readTowerStatus({
    active: towerActive,
    cwd: repo,
    agentId: currentAgentId,
    tasks: ix.get(IAgentTaskService),
    concurrency: () => ix.get(ITowerRateLimitService).snapshot(),
  });
}

function readStatusSummary() {
  return readTowerStatusSummary({
    active: towerActive,
    cwd: repo,
    agentId: currentAgentId,
    tasks: ix.get(IAgentTaskService),
    concurrency: () => ix.get(ITowerRateLimitService).snapshot(),
  });
}

describe('TowerInitTool', () => {
  it('refuses when tower mode is inactive — only the user can enable it', async () => {
    const result = await run(ix.get(ITowerInitTool), {});

    expect(result.isError).toBe(true);
    expect(result.output).toBe(TOWER_MODE_USER_ENABLED_ONLY);
    expect(towerActive).toBe(false);
    expect((await stat(join(repo, '.tower')).catch(() => undefined))).toBeUndefined();
  });

  it('creates .tower when tower mode is active', async () => {
    towerActive = true;

    const result = await run(ix.get(ITowerInitTool), {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('tower workspace initialized');
    expect(result.output).toContain('base branch: main');
    expect((await stat(join(repo, '.tower/comms'))).isDirectory()).toBe(true);
    expect(towerActive).toBe(true);
  });

  it('accepts an explicit base branch and notes the checkout mismatch', async () => {
    await git(repo, 'branch', 'develop');
    towerActive = true;

    const result = await run(ix.get(ITowerInitTool), { base: 'develop' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('base branch: develop');
    expect(result.output).toContain('the main checkout is on "main", not base "develop"');
    const state = await new TowerStore(repo).load();
    expect(state.base).toBe('develop');
  });

  it('re-anchors the base when re-initializing with a different one', async () => {
    await git(repo, 'branch', 'develop');
    await initViaTool();

    const second = await run(ix.get(ITowerInitTool), { base: 'develop' });

    expect(second.isError).toBeFalsy();
    expect(second.output).toContain('base re-anchored from "main" to "develop"');
    const state = await new TowerStore(repo).load();
    expect(state.base).toBe('develop');
  });

  it('prints the real re-anchor relation for every open mission', async () => {
    await initViaTool();
    const store = new TowerStore(repo);
    const [current, stale, planned] = await store.plan([
      { title: 'current work', scope: ['src/current/**'] },
      { title: 'stale work', scope: ['src/stale/**'] },
      { title: 'planned work', scope: ['src/planned/**'] },
    ]);
    const state = await store.load();
    await store.addWorktree(current!.worktree, current!.branch, state.base);
    await store.addWorktree(stale!.worktree, stale!.branch, state.base);
    await commitFile(
      join(repo, '.tower/worktrees', current!.worktree),
      'src/current/current.ts',
      'current\n',
      'current work',
    );
    await commitFile(
      join(repo, '.tower/worktrees', stale!.worktree),
      'src/stale/stale.ts',
      'stale\n',
      'stale work',
    );
    await git(repo, 'branch', '-f', 'develop', current!.branch);

    const result = await run(ix.get(ITowerInitTool), { base: 'develop' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(`mission ${current!.id} (${current!.branch}): up-to-date`);
    expect(result.output).toContain(`mission ${stale!.id} (${stale!.branch}): stale`);
    expect(result.output).toContain(`mission ${planned!.id} (${planned!.branch}): no-branch`);
    expect(result.output).not.toContain('their branches are behind');
  });

  it('rejects a base that is not a local branch', async () => {
    towerActive = true;

    const result = await run(ix.get(ITowerInitTool), { base: 'origin/main' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not exist as a local branch');
  });

  it('is idempotent — a second run reports already-initialized and keeps state', async () => {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'kept mission', scope: ['src/kept/**'] }],
    });

    const second = await run(ix.get(ITowerInitTool), {});
    expect(second.isError).toBeFalsy();
    expect(second.output).toContain('tower workspace already initialized');
    const state = await new TowerStore(repo).load();
    expect(state.missions).toHaveLength(1);
  });

  it('adopting from a previous session retires its roster and says so', async () => {
    await initViaTool();
    const store = new TowerStore(repo);
    await store.registerAgent({
      name: 'agent-build',
      agentId: 'agent-0',
      sessionId: 'session-test',
      kind: 'worker',
      spawnedAt: new Date().toISOString(),
    });
    currentSessionId = 'session-next';

    const second = await run(ix.get(ITowerInitTool), {});

    expect(second.isError).toBeFalsy();
    expect(second.output).toContain('retired its stale roster entries: agent-build');
    const state = await store.load();
    expect(state.sessionId).toBe('session-next');
    expect(state.roster.agents).toEqual([]);
  });

  it('refuses to adopt while the owning session is live in this process', async () => {
    await initViaTool();
    liveSessionIds = ['session-test'];
    currentSessionId = 'session-next';

    const result = await run(ix.get(ITowerInitTool), {});

    expect(result.isError).toBe(true);
    expect(result.output).toContain('owned by a live session (session-test)');
    const state = await new TowerStore(repo).load();
    expect(state.sessionId).toBe('session-test');
  });

  it('adopts once the owning session released ownership, even while it is still live', async () => {
    await initViaTool();
    liveSessionIds = ['session-test'];
    currentSessionId = 'session-next';

    const blocked = await run(ix.get(ITowerInitTool), {});
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain('owned by a live session (session-test)');

    await new TowerStore(repo).release('session-test');

    const adopted = await run(ix.get(ITowerInitTool), {});
    expect(adopted.isError).toBeFalsy();
    expect(adopted.output).toContain('tower workspace already initialized');
    const state = await new TowerStore(repo).load();
    expect(state.sessionId).toBe('session-next');
  });
});

describe('TowerPlanTool', () => {
  it('refuses when tower mode is inactive', async () => {
    const result = await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'engine', scope: ['src/engine/**'] }],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe(TOWER_MODE_USER_ENABLED_ONLY);
  });

  it('plans missions on a real repo once tower mode is active', async () => {
    await initViaTool();

    const result = await run(ix.get(ITowerPlanTool), {
      missions: [
        { title: 'Build engine', scope: ['src/engine/**'], tasks: ['scaffold'] },
        { title: 'Build UI', scope: ['src/ui/**'], deps: ['M1'] },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('planned 2 mission(s):');
    expect(result.output).toContain('| M1 | Build engine | build | feat/build-engine | wt-1 | src/engine/** |');
    expect(result.output).toContain('| M2 | Build UI | build | feat/build-ui | wt-2 | src/ui/** |');
  });

  it('passes mission context through to the stored mission', async () => {
    await initViaTool();

    const result = await run(ix.get(ITowerPlanTool), {
      missions: [
        {
          title: 'Build engine',
          scope: ['src/engine/**'],
          tasks: ['scaffold'],
          context: 'Ship it as a single binary.',
        },
      ],
    });

    expect(result.isError).toBeFalsy();
    const state = await new TowerStore(repo).load();
    expect(state.missions[0]?.context).toBe('Ship it as a single binary.');
  });

  it('rejects a re-planned title whose slugged branch is already taken, guiding a title change', async () => {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'Build engine', scope: ['src/engine/**'] }],
    });

    const result = await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'build engine', scope: ['src/engine-v2/**'] }],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('feat/build-engine');
    expect(result.output).toContain('already used by M1');
    expect(result.output).toContain('change the title');
    expect((await new TowerStore(repo).load()).missions).toHaveLength(1);
  });

  it('rejects the slug of an abandoned mission too — reuse would corrupt branch-to-mission resolution', async () => {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'Build engine', scope: ['src/engine/**'] }],
    });
    await new TowerStore(repo).updateMission('tower', 'M1', { status: 'abandoned' });

    const result = await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'Build engine', scope: ['src/web/**'] }],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('already used by M1 (abandoned)');
    expect((await new TowerStore(repo).load()).missions).toHaveLength(1);
  });

  it('rejects a non-ASCII mission title and tells the tower to re-plan in English', async () => {
    await initViaTool();

    const result = await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'Исправить ошибку входа', scope: ['src/x/**'] }],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('contains non-ASCII characters');
    expect((await new TowerStore(repo).load()).missions).toHaveLength(0);
  });
});

describe('TowerTeardownTool', () => {
  it('tears down the workspace and keeps tower mode active', async () => {
    await initViaTool();

    const result = await run(ix.get(ITowerTeardownTool), {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('tower teardown:');
    expect(result.output).toContain('Tower mode stays active');
    expect(towerActive).toBe(true);
  });

  it('refuses to tear down while the owning session is live in this process', async () => {
    await initViaTool();
    liveSessionIds = ['session-test'];
    currentSessionId = 'session-next';

    const result = await run(ix.get(ITowerTeardownTool), {});

    expect(result.isError).toBe(true);
    expect(result.output).toContain('dismantle that session');
    expect((await new TowerStore(repo).load()).sessionId).toBe('session-test');
  });

  it('tears down once the owning session released ownership, even while it is still live', async () => {
    await initViaTool();
    liveSessionIds = ['session-test'];
    currentSessionId = 'session-next';

    const blocked = await run(ix.get(ITowerTeardownTool), {});
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain('dismantle that session');

    await new TowerStore(repo).release('session-test');

    const result = await run(ix.get(ITowerTeardownTool), {});
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('tower teardown:');
  });

  it('keeps worktrees whose roster agent has a running task, even with force', async () => {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'Build engine', scope: ['src/engine/**'] }],
    });
    const store = new TowerStore(repo);
    const state = await store.load();
    const mission = state.missions[0]!;
    await store.addWorktree(mission.worktree, mission.branch, state.base);
    await store.registerAgent({
      name: 'w1',
      kind: 'worker',
      agentId: 'agent-w1',
      worktree: mission.worktree,
      spawnedAt: new Date().toISOString(),
    });
    liveAgentTaskIds.push('agent-w1');

    const result = await run(ix.get(ITowerTeardownTool), { force: true });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(
      `kept .tower/worktrees/${mission.worktree} (live agent: w1)`,
    );
    expect(
      (await stat(join(repo, '.tower/worktrees', mission.worktree))).isDirectory(),
    ).toBe(true);

    liveAgentTaskIds.length = 0;
    const settled = await run(ix.get(ITowerTeardownTool), {});
    expect(settled.output).toContain(`removed .tower/worktrees/${mission.worktree}`);
  });

  it('dry run reports the decisions and changes nothing', async () => {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'Build engine', scope: ['src/engine/**'] }],
    });
    const store = new TowerStore(repo);
    const state = await store.load();
    const mission = state.missions[0]!;
    await store.addWorktree(mission.worktree, mission.branch, state.base);

    const result = await run(ix.get(ITowerTeardownTool), { dry_run: true });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('tower teardown (dry run');
    expect(result.output).toContain(`would remove .tower/worktrees/${mission.worktree}`);
    expect(
      (await stat(join(repo, '.tower/worktrees', mission.worktree))).isDirectory(),
    ).toBe(true);
  });

  it('keeps worktrees named in exclude', async () => {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'Build engine', scope: ['src/engine/**'] }],
    });
    const store = new TowerStore(repo);
    const state = await store.load();
    const mission = state.missions[0]!;
    await store.addWorktree(mission.worktree, mission.branch, state.base);

    const result = await run(ix.get(ITowerTeardownTool), { exclude: [mission.worktree] });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(`kept .tower/worktrees/${mission.worktree} (excluded)`);
    expect(
      (await stat(join(repo, '.tower/worktrees', mission.worktree))).isDirectory(),
    ).toBe(true);
  });
});

describe('TowerSendTool + TowerInboxTool', () => {
  beforeEach(async () => {
    await initViaTool();
    const store = new TowerStore(repo);
    await store.registerAgent({
      name: 'w1',
      kind: 'worker',
      agentId: 'agent-w1',
      spawnedAt: '2026-09-20T00:00:00.000Z',
    });
    await store.registerAgent({
      name: 'w2',
      kind: 'worker',
      agentId: 'agent-w2',
      spawnedAt: '2026-09-20T00:00:00.000Z',
    });
  });

  it('worker inbox shows only own and broadcast messages; the tower sees everything', async () => {
    await run(ix.get(ITowerSendTool), { to: 'w1', subject: 'for w1', body: 'a' });
    await run(ix.get(ITowerSendTool), { to: 'w2', subject: 'for w2', body: 'b' });
    await run(ix.get(ITowerSendTool), { to: 'all', subject: 'broadcast', body: 'c' });

    currentAgentId = 'agent-w1';
    const w1Inbox = await run(ix.get(ITowerInboxTool), {});
    expect(w1Inbox.isError).toBeFalsy();
    expect(w1Inbox.output).toContain('2 message(s) for w1');
    expect(w1Inbox.output).toContain('subject: for w1');
    expect(w1Inbox.output).toContain('subject: broadcast');
    expect(w1Inbox.output).not.toContain('subject: for w2');
    expect(w1Inbox.output).toContain('0 unread message(s) remaining');

    currentAgentId = 'agent-w2';
    const w2Inbox = await run(ix.get(ITowerInboxTool), {});
    expect(w2Inbox.output).toContain('2 message(s) for w2');
    expect(w2Inbox.output).toContain('subject: broadcast');

    currentAgentId = 'agent-w1';
    await run(ix.get(ITowerSendTool), { to: 'tower', subject: 'report', body: 'd' });

    currentAgentId = 'main';
    const towerInbox = await run(ix.get(ITowerInboxTool), {});
    expect(towerInbox.output).toContain('4 message(s) for tower');
    for (const subject of ['for w1', 'for w2', 'broadcast', 'report']) {
      expect(towerInbox.output).toContain(`subject: ${subject}`);
    }
  });

  it('reads and stamps the mailbox of the latest registration when the agent id collides with a stale roster entry', async () => {
    const file = join(repo, '.tower/comms/state.json');
    const state = JSON.parse(await readFile(file, 'utf8')) as {
      roster: { agents: Record<string, unknown>[] };
    };
    state.roster.agents.unshift({
      name: 'w-stale',
      kind: 'worker',
      agentId: 'agent-w1',
      sessionId: 'session-old',
      spawnedAt: '2026-09-13T08:00:00.000Z',
    });
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);

    await run(ix.get(ITowerSendTool), { to: 'w1', subject: 'for current w1', body: 'a' });
    await run(ix.get(ITowerSendTool), { to: 'w-stale', subject: 'for stale identity', body: 'b' });

    currentAgentId = 'agent-w1';
    const inbox = await run(ix.get(ITowerInboxTool), {});
    expect(inbox.isError).toBeFalsy();
    expect(inbox.output).toContain('message(s) for w1');
    expect(inbox.output).toContain('subject: for current w1');
    expect(inbox.output).not.toContain('subject: for stale identity');

    const sent = await run(ix.get(ITowerSendTool), { to: 'tower', subject: 'report', body: 'c' });
    expect(sent.isError).toBeFalsy();
    currentAgentId = 'main';
    const towerInbox = await run(ix.get(ITowerInboxTool), {});
    expect(towerInbox.output).toContain('from: w1');
  });

  it('maps a TowerProtocolError (unknown recipient) to an isError result', async () => {
    const result = await run(ix.get(ITowerSendTool), {
      to: 'ghost',
      subject: 'hi',
      body: 'x',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('unknown recipient "ghost"');
    expect(result.output).toContain('known: tower, all, w1, w2');
  });

  it('notes when the tower messages a roster agent that has no running task to deliver it', async () => {
    const idle = await run(ix.get(ITowerSendTool), { to: 'w1', subject: 'wake', body: 'x' });
    expect(idle.isError).toBeFalsy();
    expect(idle.output).toContain('w1 has no running task');
    expect(idle.output).toContain('Agent(resume="agent-w1", run_in_background=true');

    liveAgentTaskIds.push('agent-w1');
    const busy = await run(ix.get(ITowerSendTool), { to: 'w1', subject: 'wake', body: 'x' });
    expect(busy.output).not.toContain('has no running task');
  });

  it('stamps the sender token count from the usage service into the message frontmatter', async () => {
    usageTotal = { inputOther: 100, output: 50, inputCacheRead: 10, inputCacheCreation: 5 };

    await run(ix.get(ITowerSendTool), { to: 'w1', subject: 'metered', body: 'x' });

    const dir = join(repo, '.tower/comms/inbox');
    const file = (await readdir(dir)).find((name) => name.includes('metered'));
    const { fields } = parseFrontmatter(await readFile(join(dir, file!), 'utf8'));
    expect(fields['tokens']).toBe('165');
  });

  it('records tokens as -1 when the usage service reports nothing', async () => {
    await run(ix.get(ITowerSendTool), { to: 'w1', subject: 'unmetered', body: 'x' });

    const dir = join(repo, '.tower/comms/inbox');
    const file = (await readdir(dir)).find((name) => name.includes('unmetered'));
    const { fields } = parseFrontmatter(await readFile(join(dir, file!), 'utf8'));
    expect(fields['tokens']).toBe('-1');
  });

  it('skips the delivery note for broadcasts and for sends from workers', async () => {
    const broadcast = await run(ix.get(ITowerSendTool), { to: 'all', subject: 'b', body: 'x' });
    expect(broadcast.output).not.toContain('has no running task');

    currentAgentId = 'agent-w1';
    const fromWorker = await run(ix.get(ITowerSendTool), { to: 'w2', subject: 'b', body: 'x' });
    expect(fromWorker.output).not.toContain('has no running task');
  });

  it('acks only returned unread pages, so completion waits for every page even with identical timestamps', async () => {
    const store = new TowerStore(repo);
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'Build engine', scope: ['src/engine/**'] }],
    });
    await git(repo, 'checkout', '-b', 'feat/build-engine');
    await commitFile(repo, 'src/engine/engine.ts', 'export const engine = 1;\n', 'engine work');
    await git(repo, 'checkout', 'main');
    await store.registerAgent({
      name: 'w3',
      kind: 'worker',
      agentId: 'agent-w3',
      missionId: 'M1',
      branch: 'feat/build-engine',
      spawnedAt: '2026-09-20T00:00:00.000Z',
    });
    await store.updateMission('tower', 'M1', { status: 'active', owner: 'w3' }, { silent: true });
    for (const subject of ['requirement change', 'test update', 'final note']) {
      const sent = await run(ix.get(ITowerSendTool), { to: 'w3', subject, body: 'incorporate this' });
      expect(sent.isError).toBeFalsy();
    }
    const inboxDir = join(repo, '.tower/comms/inbox');
    for (const file of await readdir(inboxDir)) {
      const path = join(inboxDir, file);
      const text = await readFile(path, 'utf8');
      await writeFile(path, text.replace(/^sent_at:.*$/m, 'sent_at: 2026-09-21T00:00:00.000Z'));
    }

    currentAgentId = 'agent-w3';
    const refused = await run(ix.get(ITowerMissionTool), { id: 'M1', status: 'completed' });
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain('3 unread inbox message(s) for w3');
    expect(refused.output).toContain('call TowerInbox');

    const firstPage = await run(ix.get(ITowerInboxTool), { limit: 2 });
    expect(firstPage.isError).toBeFalsy();
    expect(firstPage.output).toContain('2 message(s) for w3');
    expect(firstPage.output).toContain('1 unread message(s) remaining');
    let entry = (await store.load()).roster.agents.find((agent) => agent.name === 'w3');
    expect(entry?.inboxAckIds).toHaveLength(2);

    const stillRefused = await run(ix.get(ITowerMissionTool), { id: 'M1', status: 'completed' });
    expect(stillRefused.isError).toBe(true);
    expect(stillRefused.output).toContain('1 unread inbox message(s) for w3');

    const lastPage = await run(ix.get(ITowerInboxTool), { limit: 2 });
    expect(lastPage.output).toContain('1 message(s) for w3');
    expect(lastPage.output).toContain('0 unread message(s) remaining');
    entry = (await store.load()).roster.agents.find((agent) => agent.name === 'w3');
    expect(entry?.inboxAckIds).toHaveLength(3);
    expect(entry?.lastInboxReadAt).toBe('2026-09-20T00:00:00.000Z');

    const accepted = await run(ix.get(ITowerMissionTool), { id: 'M1', status: 'completed' });
    expect(accepted.isError).toBeFalsy();
    expect(accepted.output).toContain('status: completed');
  });

  it('include_read returns history without acknowledging items outside the returned page', async () => {
    const store = new TowerStore(repo);
    for (const subject of ['one', 'two', 'three']) {
      await run(ix.get(ITowerSendTool), { to: 'w1', subject, body: subject });
    }
    currentAgentId = 'agent-w1';

    const firstPage = await run(ix.get(ITowerInboxTool), { limit: 2 });
    expect(firstPage.output).toContain('1 unread message(s) remaining');
    const history = await run(ix.get(ITowerInboxTool), { limit: 2, include_read: true });
    expect(history.output).toContain('2 message(s) for w1');
    expect(history.output).toContain('1 unread message(s) remaining');
    expect(
      (await store.load()).roster.agents.find((agent) => agent.name === 'w1')?.inboxAckIds,
    ).toHaveLength(2);

    const lastPage = await run(ix.get(ITowerInboxTool), {});
    expect(lastPage.output).toContain('1 message(s) for w1');
    expect(lastPage.output).toContain('0 unread message(s) remaining');
    const stateFile = join(repo, '.tower/comms/state.json');
    const beforeEmptyPage = await readFile(stateFile, 'utf8');
    const emptyPage = await run(ix.get(ITowerInboxTool), {});
    expect(emptyPage.output).toContain('0 unread message(s) remaining');
    expect(await readFile(stateFile, 'utf8')).toBe(beforeEmptyPage);

    const fullHistory = await run(ix.get(ITowerInboxTool), { limit: 3, include_read: true });
    expect(fullHistory.output).toContain('3 message(s) for w1');
    expect(fullHistory.output).toContain('0 unread message(s) remaining');
  });

  it('steers a message into a running agent loop so it lands at the next step boundary', async () => {
    agentLoops.set('agent-w1', { state: 'running', submitted: [] });

    const result = await run(ix.get(ITowerSendTool), {
      to: 'w1',
      subject: 'rebase now',
      body: 'rebase onto latest main',
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('steered into its running turn');
    const loop = agentLoops.get('agent-w1')!;
    expect(loop.submitted).toHaveLength(1);
    expect(loop.submitted[0]).toContain('new message from tower: "rebase now"');
    expect(loop.submitted[0]).toContain('TowerInbox');
  });

  it('does not steer into an idle loop — the message waits in the inbox', async () => {
    agentLoops.set('agent-w1', { state: 'idle', submitted: [] });

    const result = await run(ix.get(ITowerSendTool), { to: 'w1', subject: 'later', body: 'x' });

    expect(agentLoops.get('agent-w1')!.submitted).toHaveLength(0);
    expect(result.output).not.toContain('steered into its running turn');
  });

  it('steers worker-to-worker sends into the sibling loop', async () => {
    agentLoops.set('agent-w2', { state: 'running', submitted: [] });
    currentAgentId = 'agent-w1';

    const result = await run(ix.get(ITowerSendTool), { to: 'w2', subject: 'contract', body: 'x' });

    expect(result.output).toContain('steered into its running turn');
    expect(agentLoops.get('agent-w2')!.submitted[0]).toContain('new message from w1');
  });
});

describe('TowerStatusTool', () => {
  it('keeps active independent from the initialized dashboard data', async () => {
    expect(await readStatus()).toEqual({ active: false, initialized: false, stateLost: false });

    towerActive = true;
    expect(await readStatus()).toEqual({ active: true, initialized: false, stateLost: false });

    await run(ix.get(ITowerInitTool), {});
    const activeStatus = await readStatus();
    expect(activeStatus).toMatchObject({ active: true, initialized: true });

    towerActive = false;
    const inactiveStatus = await readStatus();
    expect(inactiveStatus).toEqual({ ...activeStatus, active: false });
    expect(inactiveStatus).toMatchObject({
      initialized: true,
      state: { base: 'main', mode: 'branch', missions: [], roster: { agents: [] } },
      caller: 'tower',
      gate: [],
      inbox: { count: 0 },
      concurrency: { budget: 2, inflight: 0, blockedUntil: null },
    });
  });

  it('renders the dashboard including the rate-limiter concurrency section', async () => {
    await initViaTool();

    const result = await run(ix.get(ITowerStatusTool), {});
    const status = await readStatus();

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('# Tower status — base: main (mode: branch), you are: tower');
    expect(result.output).toContain('(no missions planned — use TowerPlan)');
    expect(result.output).toContain('budget: 2 agent(s) · inflight: 0 · spawns open');
    expect(status).toMatchObject({
      active: true,
      initialized: true,
      state: { base: 'main', mode: 'branch', missions: [], roster: { agents: [] } },
      caller: 'tower',
      gate: [],
      inbox: { count: 0 },
      concurrency: { budget: 2, inflight: 0, blockedUntil: null },
      recentActivity: expect.arrayContaining([expect.stringContaining(' tower init')]),
    });
  });

  it('keeps the Markdown dashboard available to tower workers', async () => {
    await initViaTool();
    await new TowerStore(repo).registerAgent({
      name: 'w1',
      kind: 'worker',
      agentId: 'agent-w1',
      spawnedAt: new Date().toISOString(),
    });
    towerActive = false;
    currentAgentId = 'agent-w1';

    const result = await run(ix.get(ITowerStatusTool), {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('# Tower status — base: main (mode: branch)');
    expect(result.output).not.toContain('# Tower status — OFF');
  });

  it('marks dead roster agents and warns about the missions they own', async () => {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'engine', scope: ['src/engine/**'] }],
    });
    const store = new TowerStore(repo);
    await store.registerAgent({
      name: 'w1',
      kind: 'worker',
      agentId: 'agent-w1',
      missionId: 'M1',
      spawnedAt: new Date().toISOString(),
    });
    await store.updateMission('tower', 'M1', { status: 'active', owner: 'w1' }, { silent: true });
    await store.markAgentDied('agent-w1', 'failed', 'provider blew up');

    const result = await run(ix.get(ITowerStatusTool), {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('w1 (worker) — agent agent-w1, mission M1');
    expect(result.output).toContain('💀 failed');
    expect(result.output).toContain('## Dead workers');
    expect(result.output).toContain('M1 owner w1 died (failed)');
    expect(result.output).toContain('diagnose first: check why it died');
    expect(result.output).toContain('lost contact, timeout, OOM');
    expect(result.output).toMatch(
      /died \(failed\) — diagnose first[\s\S]*Agent\(resume="agent-w1", run_in_background=true/,
    );
  });

  it('advises fixing or escalating a systematic death cause before any revive', async () => {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'engine', scope: ['src/engine/**'] }],
    });
    const store = new TowerStore(repo);
    await store.registerAgent({
      name: 'w1',
      kind: 'worker',
      agentId: 'agent-w1',
      missionId: 'M1',
      spawnedAt: new Date().toISOString(),
    });
    await store.updateMission('tower', 'M1', { status: 'active', owner: 'w1' }, { silent: true });
    await store.markAgentDied('agent-w1', 'failed', 'TS2304: Cannot find name');

    const result = await run(ix.get(ITowerStatusTool), {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('M1 owner w1 died (failed)');
    expect(result.output).toContain('systematic cause');
    expect(result.output).toContain('fixed or escalated to the human before any revive');
  });

  it('shows a user-stopped roster agent without the recovery hint', async () => {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'engine', scope: ['src/engine/**'] }],
    });
    const store = new TowerStore(repo);
    await store.registerAgent({
      name: 'w1',
      kind: 'worker',
      agentId: 'agent-w1',
      missionId: 'M1',
      spawnedAt: new Date().toISOString(),
    });
    await store.updateMission('tower', 'M1', { status: 'active', owner: 'w1' }, { silent: true });
    await store.markAgentDied('agent-w1', 'killed', userCancellationReason().message);

    const result = await run(ix.get(ITowerStatusTool), {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('w1 (worker) — agent agent-w1, mission M1');
    expect(result.output).toContain('💀 killed');
    expect(result.output).toContain('## Dead workers');
    expect(result.output).toContain('M1 owner w1 was stopped by the user (killed)');
    expect(result.output).toContain('dead by intent');
    expect(result.output).not.toContain('diagnose first');
    expect(result.output).not.toContain('Agent(resume=');
  });

  it('flags planned missions without a spawned worker in an Awaiting spawn section', async () => {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [
        { title: 'Build engine', scope: ['src/engine/**'] },
        { title: 'Build UI', scope: ['src/ui/**'] },
      ],
    });
    const store = new TowerStore(repo);
    await store.updateMission('tower', 'M2', { status: 'active', owner: 'w-ui' }, { silent: true });

    const result = await run(ix.get(ITowerStatusTool), {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('## Awaiting spawn');
    expect(result.output).toContain('M1 (feat/build-engine) — planned but no worker spawned yet');
    expect(result.output).toContain('TowerSpawn(kind="worker", mission_id="M1"');
    expect(result.output).not.toContain('M2 (feat/build-ui) — planned but no worker spawned yet');

    await store.updateMission('tower', 'M1', { status: 'active', owner: 'w-engine' }, { silent: true });
    const settled = await run(ix.get(ITowerStatusTool), {});
    expect(settled.output).not.toContain('## Awaiting spawn');
  });

  it('uses the merge evaluator for clean-rebase waivers and marks worker runtime unknown off-main', async () => {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'Build engine', scope: ['src/engine/**'] }],
    });
    const store = new TowerStore(repo);
    const state = await store.load();
    const mission = state.missions[0]!;
    await store.addWorktree(mission.worktree, mission.branch, state.base);
    const worktree = join(repo, '.tower/worktrees', mission.worktree);
    await commitFile(worktree, 'src/engine/engine.ts', 'export const engine = 1;\n', 'engine work');
    await store.updateMission('tower', mission.id, { status: 'completed' }, { silent: true });
    await store.registerAgent({
      name: 'w1',
      kind: 'worker',
      agentId: 'agent-w1',
      missionId: mission.id,
      worktree: mission.worktree,
      branch: mission.branch,
      spawnedAt: new Date().toISOString(),
    });
    await store.registerAgent({
      name: 'r1',
      kind: 'reviewer',
      agentId: 'agent-r1',
      reviewTarget: mission.branch,
      reviewMissionId: mission.id,
      spawnedAt: new Date().toISOString(),
    });
    await store.submitReview('r1', {
      target: mission.branch,
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'ok',
    });
    await commitFile(repo, 'docs/readme.md', 'docs\n', 'base moves on');
    await store.rebaseMission('tower', mission.id, { activeAgentIds: new Set() });

    const mainStatus = await run(ix.get(ITowerStatusTool), {});

    expect(mainStatus.isError).toBeFalsy();
    expect(mainStatus.output).toContain('READY reasons=none');
    expect(mainStatus.output).toContain('binding=clean-rebase-waived');

    liveAgentTaskIds.push('agent-w1');
    const busyStatus = await run(ix.get(ITowerStatusTool), {});
    expect(busyStatus.output).toContain('BLOCKED reasons=worker-busy');
    liveAgentTaskIds.length = 0;

    currentAgentId = 'agent-w1';
    const workerStatus = await run(ix.get(ITowerStatusTool), {});
    expect(workerStatus.isError).toBeFalsy();
    expect(workerStatus.output).toContain('BLOCKED reasons=worker-unknown');
    expect(workerStatus.output).toContain('unknown is not idle');
    expect(workerStatus.output).not.toContain('READY reasons=none');
  });
});

describe('readTowerStatusSummary', () => {
  it('renders the uninitialized states as one- and two-line text', async () => {
    expect(await readStatusSummary()).toBe('Tower mode: OFF');

    towerActive = true;
    expect(await readStatusSummary()).toBe('Tower mode: ON\nTower is not initialized.');
  });

  it('renders the initialized dashboard as compact text with a state headline', async () => {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'Build engine', scope: ['src/engine/**'] }],
    });
    const store = new TowerStore(repo);
    await store.registerAgent({
      name: 'w1',
      kind: 'worker',
      agentId: 'agent-w1',
      missionId: 'M1',
      branch: 'feat/build-engine',
      worktree: 'build-engine',
      spawnedAt: new Date().toISOString(),
    });
    await store.updateMission('tower', 'M1', { status: 'active', owner: 'w1' }, { silent: true });

    const summary = await readStatusSummary();

    const [headline, ...bodyLines] = summary.split('\n');
    expect(headline).toBe('Tower status — ON');
    const body = bodyLines.join('\n');
    expect(body).toContain('Base: main (mode: branch) · You are: tower');
    expect(body).toContain('Missions:\n  M1 Build engine — active · owner w1 · feat/build-engine');
    expect(body).toContain('Roster:\n  w1 (worker) — mission M1 · agent-w1');
    expect(body).toContain('Review gate:\n  M1 feat/build-engine — BLOCKED: not-completed');
    expect(body).toContain('Inbox: 0 message(s)');
    expect(body).toContain('Concurrency: budget: 2 agent(s) · inflight: 0 · spawns open');
    expect(body).toContain('Recent activity:');
    expect(body).toContain(' tower init');

    towerActive = false;
    const inactiveSummary = await readStatusSummary();
    const [inactiveHeadline, ...inactiveBodyLines] = inactiveSummary.split('\n');
    expect(inactiveHeadline).toBe('Tower mode: OFF');
    expect(inactiveBodyLines.join('\n')).toBe(body);
  });
});

describe('TowerCompleteTool', () => {
  async function setupCompletable(kind: 'build' | 'survey' = 'build') {
    await initViaTool();
    const store = new TowerStore(repo);
    const [mission] = await store.plan([
      {
        title: kind === 'survey' ? 'Survey engine' : 'Build engine',
        scope: ['src/engine/**'],
        kind,
      },
    ]);
    const state = await store.load();
    await store.addWorktree(mission!.worktree, mission!.branch, state.base);
    if (kind === 'build') {
      await commitFile(
        join(repo, '.tower/worktrees', mission!.worktree),
        'src/engine/engine.ts',
        'export const engine = 1;\n',
        'engine work',
      );
    }
    await store.registerAgent({
      name: 'w1',
      kind: 'worker',
      agentId: 'agent-w1',
      missionId: mission!.id,
      worktree: mission!.worktree,
      branch: mission!.branch,
      spawnedAt: new Date().toISOString(),
    });
    await store.updateMission(
      'tower',
      mission!.id,
      { status: 'active', owner: 'w1' },
      { silent: true },
    );
    currentAgentId = 'agent-w1';
    return { store, mission: mission! };
  }

  it('completes a build mission and stores one review-request with mission metadata', async () => {
    const { store } = await setupCompletable();

    const result = await run(ix.get(ITowerCompleteTool), { report: 'implemented the engine' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('mission M1 persisted as completed');
    expect(result.output).toContain('review-request notification:');
    expect(result.output).toContain('notification: stored once');
    expect((await store.load()).missions[0]?.status).toBe('completed');
    const messages = await store.readInbox('tower', 20);
    const notification = messages.find((item) => item.subject === 'review-request');
    expect(notification).toMatchObject({
      from: 'w1',
      to: 'tower',
      body: 'implemented the engine',
      scope: 'M1',
      action: 'complete',
    });
  });

  it('completes a zero-diff survey with survey-summary', async () => {
    const { store } = await setupCompletable('survey');

    const result = await run(ix.get(ITowerCompleteTool), { report: 'survey findings' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('survey-summary notification:');
    const messages = await store.readInbox('tower', 20);
    expect(messages.find((item) => item.subject === 'survey-summary')).toMatchObject({
      body: 'survey findings',
      scope: 'M1',
      action: 'complete',
    });
  });

  it('rejects the tower and reviewers without writing a completion notification', async () => {
    const { store } = await setupCompletable();
    currentAgentId = 'main';
    const towerResult = await run(ix.get(ITowerCompleteTool), { report: 'not mine' });
    expect(towerResult.isError).toBe(true);
    expect(towerResult.output).toContain('only the worker');

    await store.registerAgent({
      name: 'r1',
      kind: 'reviewer',
      agentId: 'agent-r1',
      reviewTarget: 'feat/build-engine',
      reviewMissionId: 'M1',
      spawnedAt: new Date().toISOString(),
    });
    currentAgentId = 'agent-r1';
    const reviewerResult = await run(ix.get(ITowerCompleteTool), { report: 'not mine either' });
    expect(reviewerResult.isError).toBe(true);
    expect(reviewerResult.output).toContain('only the worker');
    expect((await store.readInbox('tower', 20)).some((item) => item.action === 'complete')).toBe(false);
  });

  it('fails unread completion checks before writing a notification', async () => {
    const { store } = await setupCompletable();
    await store.send('tower', { to: 'w1', subject: 'requirement change', body: 'read me' });

    const result = await run(ix.get(ITowerCompleteTool), { report: 'premature completion' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('unread inbox message');
    expect((await store.load()).missions[0]?.status).toBe('active');
    expect((await store.readInbox('tower', 20)).some((item) => item.action === 'complete')).toBe(false);
  });

  it('refuses to complete while blockers remain', async () => {
    const { store } = await setupCompletable();
    await store.updateMission('tower', 'M1', { blocker: 'still blocked' });

    const result = await run(ix.get(ITowerCompleteTool), { report: 'blocked completion' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('blocker(s) remain');
    expect((await store.load()).missions[0]?.status).toBe('blocked');
    expect((await store.readInbox('tower', 20)).some((item) => item.action === 'complete')).toBe(false);
  });

  it('rechecks unread messages before creating a different notification for a completed mission', async () => {
    const { store } = await setupCompletable();
    const first = await run(ix.get(ITowerCompleteTool), { report: 'original report' });
    expect(first.isError).toBeFalsy();
    await store.send('tower', { to: 'w1', subject: 'late requirement change', body: 'read before new report' });

    const result = await run(ix.get(ITowerCompleteTool), { report: 'different report' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('unread inbox message');
    expect((await store.load()).missions[0]?.status).toBe('completed');
    const messages = await store.readInbox('tower', 20);
    expect(messages.filter((item) => item.action === 'complete')).toHaveLength(1);
    expect(messages.find((item) => item.action === 'complete')?.body).toBe('original report');
  });

  it('rejects a non-zero survey branch during completion without a summary', async () => {
    const { store, mission } = await setupCompletable('survey');
    await commitFile(
      join(repo, '.tower/worktrees', mission.worktree),
      'src/engine/notes.ts',
      'not allowed\n',
      'survey edit',
    );

    const result = await run(ix.get(ITowerCompleteTool), { report: 'survey with edits' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('read-only survey');
    expect((await store.load()).missions[0]?.status).toBe('active');
    expect((await store.readInbox('tower', 20)).some((item) => item.action === 'complete')).toBe(false);
  });

  it('reports persisted completion on notification failure and reuses the message on retry', async () => {
    const { store } = await setupCompletable();
    const failure = vi
      .spyOn(TowerStore.prototype, 'appendLog')
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error('forced notification write failure'));
    try {
      const first = await run(ix.get(ITowerCompleteTool), { report: 'retry report' });

      expect(first.isError).toBe(true);
      expect(first.output).toContain('mission M1 persisted as completed');
      expect(first.output).toContain('activity log error');
      expect(first.output).toContain('forced notification write failure');
      const before = await store.readInbox('tower', 20);
      expect(before.filter((item) => item.action === 'complete')).toHaveLength(1);
      failure.mockRestore();

      const second = await run(ix.get(ITowerCompleteTool), { report: 'retry report' });

      expect(second.isError).toBeFalsy();
      expect(second.output).toContain('reused the stored message');
      const after = await store.readInbox('tower', 20);
      expect(after.filter((item) => item.action === 'complete')).toHaveLength(1);
      expect(after.find((item) => item.action === 'complete')?.file).toBe(
        before.find((item) => item.action === 'complete')?.file,
      );
    } finally {
      failure.mockRestore();
    }
  });
});

describe('TowerReviewTool', () => {
  async function setupReviewableBranch(options: { readonly withOwner?: boolean } = {}) {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'Build engine', scope: ['src/engine/**'] }],
    });
    await git(repo, 'branch', 'feat/build-engine');
    const store = new TowerStore(repo);
    if (options.withOwner !== false) {
      await store.registerAgent({
        name: 'w1',
        kind: 'worker',
        agentId: 'agent-w1',
        missionId: 'M1',
        spawnedAt: new Date().toISOString(),
      });
      await store.updateMission('tower', 'M1', { status: 'active', owner: 'w1' }, { silent: true });
    }
    await store.registerAgent({
      name: 'r1',
      kind: 'reviewer',
      agentId: 'agent-r1',
      reviewTarget: 'feat/build-engine',
      reviewMissionId: 'M1',
      spawnedAt: new Date().toISOString(),
    });
    currentAgentId = 'agent-r1';
    return store;
  }

  it('routes a non-clean verdict at the owning worker with the review file', async () => {
    const store = await setupReviewableBranch();

    const result = await run(ix.get(ITowerReviewTool), {
      target: 'feat/build-engine',
      status: 'p1-2items',
      merge: 'hold',
      findings: 'broken error handling',
      decision: 'needs rework',
    });

    expect(result.isError).toBeFalsy();
    const review = await store.latestReview('feat/build-engine');
    expect(review).toBeDefined();
    expect(result.output).toContain(`review submitted: ${review!.file}`);
    expect(result.output).toContain('notified: w1, tower');
    expect(result.output).toContain('the author must fix and re-review');
    expect(result.output).not.toContain('Agent(resume=');
    expect(result.output).not.toContain('TowerSend');
    expect(result.output).not.toContain('is merge-ready');
  });

  it('reports a clean verdict as merge-ready for TowerMerge', async () => {
    await setupReviewableBranch();

    const result = await run(ix.get(ITowerReviewTool), {
      target: 'feat/build-engine',
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'looks good',
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('next: feat/build-engine is merge-ready');
    expect(result.output).toContain('TowerMerge');
    expect(result.output).toContain('notified: tower');
    expect(result.output).not.toContain('resume w1');
  });

  it('preserves the review and recovers without a new round or duplicate after review.write log failure', async () => {
    const store = await setupReviewableBranch();
    const failure = vi
      .spyOn(TowerStore.prototype, 'appendLog')
      .mockRejectedValueOnce(new Error('forced review.write activity log failure'));
    const input = {
      target: 'feat/build-engine',
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'looks good',
    } as const;
    try {
      const first = await run(ix.get(ITowerReviewTool), input);

      expect(first.isError).toBe(true);
      expect(first.output).toContain('review submitted:');
      expect(first.output).toContain('activity log error');
      expect(first.output).toContain('was stored');
      expect(first.output).toContain('forced review.write activity log failure');
      const firstReview = await store.latestReview('feat/build-engine');
      expect(firstReview?.round).toBe(1);
      expect((await store.readInbox('tower', 20)).filter((item) => item.action === 'review-result')).toHaveLength(1);
      failure.mockRestore();

      const second = await run(ix.get(ITowerReviewTool), input);

      expect(second.isError).toBeFalsy();
      const secondReview = await store.latestReview('feat/build-engine');
      expect(secondReview?.round).toBe(1);
      expect(secondReview?.file).toBe(firstReview?.file);
      expect(await store.reviewsFor('feat/build-engine')).toHaveLength(1);
      expect((await store.readInbox('tower', 20)).filter((item) => item.action === 'review-result')).toHaveLength(1);
    } finally {
      failure.mockRestore();
    }
  });

  it('recovers an inbox.send log failure without a new review round or duplicate message', async () => {
    const store = await setupReviewableBranch();
    const failure = vi
      .spyOn(TowerStore.prototype, 'appendLog')
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error('forced inbox.send activity log failure'));
    const input = {
      target: 'feat/build-engine',
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'looks good',
    } as const;
    try {
      const first = await run(ix.get(ITowerReviewTool), input);

      expect(first.isError).toBe(true);
      expect(first.output).toContain('activity log error');
      expect(first.output).toContain('inbox.send activity log failed');
      const firstReview = await store.latestReview('feat/build-engine');
      expect(firstReview?.round).toBe(1);
      expect((await store.readInbox('tower', 20)).filter((item) => item.action === 'review-result')).toHaveLength(1);
      failure.mockRestore();

      const second = await run(ix.get(ITowerReviewTool), input);

      expect(second.isError).toBeFalsy();
      expect((await store.latestReview('feat/build-engine'))?.file).toBe(firstReview?.file);
      expect(await store.reviewsFor('feat/build-engine')).toHaveLength(1);
      expect((await store.readInbox('tower', 20)).filter((item) => item.action === 'review-result')).toHaveLength(1);
    } finally {
      failure.mockRestore();
    }
  });

  it('does not call a clean hold review merge-ready', async () => {
    await setupReviewableBranch();

    const result = await run(ix.get(ITowerReviewTool), {
      target: 'feat/build-engine',
      status: 'clean',
      merge: 'hold',
      findings: 'none',
      decision: 'wait for coordination',
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain('merge-ready');
    expect(result.output).toContain('blocked by the latest review\'s "hold" verdict');
    expect(result.output).toContain('merge gate rejects it');
  });

  it('does not call a clean fix-then-merge review merge-ready', async () => {
    await setupReviewableBranch();

    const result = await run(ix.get(ITowerReviewTool), {
      target: 'feat/build-engine',
      status: 'clean',
      merge: 'fix-then-merge',
      findings: 'none',
      decision: 'approval only after fixes',
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain('merge-ready');
    expect(result.output).toContain('"fix-then-merge" is not approval');
    expect(result.output).toContain('merge gate requires a clean review with merge verdict "merge"');
  });

  it('routes a non-clean verdict through the tower when no worker owns the branch', async () => {
    await setupReviewableBranch({ withOwner: false });

    const result = await run(ix.get(ITowerReviewTool), {
      target: 'feat/build-engine',
      status: 'p2-1items',
      merge: 'fix-then-merge',
      findings: 'minor cleanup',
      decision: 'rework needed',
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('notified: tower');
    expect(result.output).toContain('the author must fix and re-review');
    expect(result.output).not.toContain('Agent(resume=');
  });
});

describe('TowerMergeTool', () => {
  async function setupMergeableBranch() {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'Build engine', scope: ['src/engine/**'] }],
    });
    await git(repo, 'checkout', '-b', 'feat/build-engine');
    await commitFile(repo, 'src/engine/engine.ts', 'export const engine = 1;\n', 'engine work');
    await git(repo, 'checkout', 'main');
    const store = new TowerStore(repo);
    await store.updateMission('tower', 'M1', { status: 'completed' }, { silent: true });
    await store.submitReview('tower', {
      target: 'feat/build-engine',
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'ok',
    });
    return store;
  }

  it('points at TowerTeardown when the merge closes the last open mission', async () => {
    await setupMergeableBranch();

    const result = await run(ix.get(ITowerMergeTool), { branch: 'feat/build-engine' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('merged feat/build-engine');
    expect(result.output).toContain('ready for TowerTeardown');
    expect(result.output).not.toContain('Continue with the remaining missions');
  });

  it('points at the remaining missions while others are still open', async () => {
    await setupMergeableBranch();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'Build UI', scope: ['src/ui/**'] }],
    });

    const result = await run(ix.get(ITowerMergeTool), { branch: 'feat/build-engine' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Continue with the remaining missions in Dependency Flow order');
    expect(result.output).not.toContain('ready for TowerTeardown');
  });

  it('points at TowerTeardown when a survey noop-merge closes the last mission', async () => {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'Survey engine', scope: ['src/engine/**'], kind: 'survey' }],
    });
    await git(repo, 'branch', 'feat/survey-engine');
    await new TowerStore(repo).updateMission(
      'tower',
      'M1',
      { status: 'completed' },
      { silent: true },
    );

    const result = await run(ix.get(ITowerMergeTool), { branch: 'feat/survey-engine' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('read-only survey');
    expect(result.output).toContain('ready for TowerTeardown');
  });
});

describe('TowerRebaseTool', () => {
  async function setupRebasableMission() {
    await initViaTool();
    const store = new TowerStore(repo);
    const [mission] = await store.plan([
      { title: 'Build engine', scope: ['src/engine/**'] },
    ]);
    const state = await store.load();
    await store.addWorktree(mission!.worktree, mission!.branch, state.base);
    const worktree = join(repo, '.tower/worktrees', mission!.worktree);
    await commitFile(worktree, 'src/engine/engine.ts', 'export const engine = 1;\n', 'engine work');
    return { store, mission: mission! };
  }

  it('rebases a stale branch and preserves review binding without changing merge approval', async () => {
    const { mission } = await setupRebasableMission();
    await commitFile(repo, 'docs/readme.md', 'docs\n', 'base moves on');

    const result = await run(ix.get(ITowerRebaseTool), { mission: mission.id });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(`rebased mission ${mission.id}`);
    expect(result.output).toContain('keeps its exact-tip binding');
    expect(result.output).toContain('merge verdict "merge"');
  });

  it('reports up-to-date branches without touching them', async () => {
    const { mission } = await setupRebasableMission();

    const result = await run(ix.get(ITowerRebaseTool), { mission: mission.id });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('already up to date');
  });

  it('refuses while the worker is mid-turn', async () => {
    const { store, mission } = await setupRebasableMission();
    await store.registerAgent({
      name: 'w1',
      kind: 'worker',
      agentId: 'agent-w1',
      missionId: mission.id,
      spawnedAt: new Date().toISOString(),
    });
    liveAgentTaskIds.push('agent-w1');
    await commitFile(repo, 'docs/readme.md', 'docs\n', 'base moves on');

    const result = await run(ix.get(ITowerRebaseTool), { mission: mission.id });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('mid-turn');
  });

  it('reports a conflicting rebase and marks the mission blocked', async () => {
    const { store, mission } = await setupRebasableMission();
    await commitFile(repo, 'src/engine/engine.ts', 'export const engine = 2;\n', 'base conflicts');

    const result = await run(ix.get(ITowerRebaseTool), { mission: mission.id });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('conflicted and was aborted');
    expect(result.output).toContain('src/engine/engine.ts');
    expect((await store.load()).missions[0]?.status).toBe('blocked');
  });
});

describe('tower state loss degradation', () => {
  async function destroyComms(): Promise<void> {
    await rm(join(repo, '.tower/comms'), { recursive: true, force: true });
  }

  it('TowerStatus returns a state-lost report instead of hard-failing, and keeps not-initialized for a fresh repo', async () => {
    towerActive = true;
    const fresh = await run(ix.get(ITowerStatusTool), {});
    expect(fresh.isError).toBe(true);
    expect(fresh.output).toContain('tower is not initialized in this repository');
    expect(await readStatus()).toEqual({ active: true, initialized: false, stateLost: false });

    await initViaTool();
    await destroyComms();

    expect(await readStatus()).toEqual({ active: true, initialized: false, stateLost: true });
    const result = await run(ix.get(ITowerStatusTool), {});
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('# Tower status — STATE LOST');
    expect(result.output).toContain('Report this history loss to the user');
    expect(result.output).toContain('TowerMerge and TowerRebase refuse');

    const summary = await readStatusSummary();
    expect(summary).toContain('Tower mode: ON');
    expect(summary).toContain('Tower state was lost');
  });

  it('TowerSend recovers a minimal state stamped recoveredAt and delivers normally', async () => {
    await initViaTool();
    await destroyComms();

    const result = await run(ix.get(ITowerSendTool), {
      to: 'all',
      subject: 'state check',
      body: 'x',
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('message sent to all');
    const state = await new TowerStore(repo).load();
    expect(state.base).toBe('main');
    expect(state.recoveredAt).toBeTruthy();
    expect(state.missions).toEqual([]);
    expect(state.roster.agents).toEqual([]);
  });

  it('a worker whose roster entry was lost is re-registered as a placeholder and its report reaches the tower', async () => {
    await initViaTool();
    const store = new TowerStore(repo);
    await store.registerAgent({
      name: 'w1',
      kind: 'worker',
      agentId: 'agent-w1',
      spawnedAt: '2026-09-20T00:00:00.000Z',
    });
    await destroyComms();

    currentAgentId = 'agent-w1';
    const result = await run(ix.get(ITowerSendTool), {
      to: 'tower',
      subject: 'accident report',
      body: 'comms was deleted',
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('message sent to tower');
    expect(result.output).toContain('placeholder "agent-w1"');
    expect((await store.load()).roster.agents).toEqual([
      expect.objectContaining({ name: 'agent-w1', agentId: 'agent-w1', kind: 'worker' }),
    ]);

    currentAgentId = 'main';
    const inbox = await run(ix.get(ITowerInboxTool), {});
    expect(inbox.output).toContain('subject: accident report');
    expect(inbox.output).toContain('from: agent-w1');
  });

  it('TowerComplete degrades explicitly: the report reaches the tower and no mission is marked completed', async () => {
    await initViaTool();
    const store = new TowerStore(repo);
    await store.plan([{ title: 'Build engine', scope: ['src/engine/**'] }]);
    await store.registerAgent({
      name: 'w1',
      kind: 'worker',
      agentId: 'agent-w1',
      missionId: 'M1',
      spawnedAt: new Date().toISOString(),
    });
    await destroyComms();

    currentAgentId = 'agent-w1';
    const result = await run(ix.get(ITowerCompleteTool), { report: 'done: implemented engine' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('no mission was marked completed');
    expect(result.output).toContain('completion-report-state-lost');
    expect((await store.load()).missions).toEqual([]);

    currentAgentId = 'main';
    const inbox = await run(ix.get(ITowerInboxTool), {});
    expect(inbox.output).toContain('done: implemented engine');

    currentAgentId = 'agent-w1';
    const retry = await run(ix.get(ITowerCompleteTool), { report: 'done: implemented engine' });
    expect(retry.output).toContain('reused the stored message');
  });

  it('TowerStatus and the status summary flag a recovered state with its recoveredAt marker', async () => {
    await initViaTool();
    await destroyComms();
    await run(ix.get(ITowerSendTool), { to: 'all', subject: 'trigger recovery', body: 'x' });

    const result = await run(ix.get(ITowerStatusTool), {});
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('## ⚠️ State recovered after a loss');
    expect(result.output).toContain('Report the history loss to the user');

    const summary = await readStatusSummary();
    expect(summary).toContain('⚠️ State recovered at');
    expect(summary).toContain('report this history loss to the user');
  });

  it('TowerMerge and TowerRebase fail with an explicit state-lost error instead of a not-initialized one', async () => {
    await initViaTool();
    await destroyComms();

    const merge = await run(ix.get(ITowerMergeTool), { branch: 'feat/x' });
    expect(merge.isError).toBe(true);
    expect(merge.output).toContain('tower state was lost');
    expect(merge.output).not.toContain('tower is not initialized');

    const rebase = await run(ix.get(ITowerRebaseTool), { mission: 'M1' });
    expect(rebase.isError).toBe(true);
    expect(rebase.output).toContain('tower state was lost');
    expect(rebase.output).not.toContain('tower is not initialized');

    expect(await new TowerStore(repo).isInitialized()).toBe(false);
  });
});

describe('tool registration', () => {
  it('declares no when gate on any tower tool contribution', () => {
    for (const contribution of TOWER_TOOL_CONTRIBUTIONS) {
      expect('when' in contribution, contribution.name).toBe(false);
    }
  });

  it('rejects orchestration tools at execution time for non-main agents', async () => {
    currentAgentId = 'agent-w1';
    const cases: readonly (readonly [ServiceIdentifier<AnyAgentTool>, unknown])[] = [
      [ITowerInitTool, {}],
      [ITowerPlanTool, { missions: [] }],
      [ITowerMergeTool, { branch: 'tower/x' }],
      [ITowerRebaseTool, { mission: 'M1' }],
      [ITowerTeardownTool, {}],
    ];
    for (const [id, args] of cases) {
      const result = await run(ix.get(id), args as never);
      expect(result.isError).toBe(true);
      expect(result.output).toBe('Tower orchestration tools are only supported by the main agent.');
    }
    expect(towerActive).toBe(false);
    expect((await stat(join(repo, '.tower')).catch(() => undefined))).toBeUndefined();
  });
});
