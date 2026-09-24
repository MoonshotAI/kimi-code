import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService, type AgentTaskInfo } from '#/agent/task/task';
import type { AnyAgentTool } from '#/agent/toolRegistry/toolContribution';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { TOWER_TOOL_CONTRIBUTIONS } from '#/features/tower/towerFeature';
import { IAgentTowerService } from '#/features/tower/tower';
import { ITowerRateLimitService } from '#/features/tower/towerRateLimit';
import { TowerStore, parseFrontmatter } from '#/features/tower/protocol/index';
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
let towerRequestedBase: string | undefined;
let currentAgentId: string;
let currentSessionId: string;
let liveSessionIds: string[];
let liveAgentTaskIds: string[];
let usageTotal: TokenUsage | undefined;
const agentContexts = new Map<string, AgentContext>();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'tower-tools-test-'));
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'tower-test@example.com');
  await git(repo, 'config', 'user.name', 'Tower Test');
  await commitFile(repo, 'README.md', '# fixture\n', 'initial');

  towerActive = false;
  towerRequestedBase = undefined;
  currentAgentId = 'main';
  liveSessionIds = [];
  liveAgentTaskIds = [];
  usageTotal = undefined;
  currentSessionId = 'session-test';
  agentContexts.clear();

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
        get requestedBase() {
          return towerRequestedBase;
        },
        enter: () => {
          towerActive = true;
          return Promise.resolve({ entered: true as const });
        },
        exit: () => {
          towerActive = false;
          return Promise.resolve();
        },
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
      reg.define(ITowerInitTool, TowerInitTool);
      reg.define(ITowerPlanTool, TowerPlanTool);
      reg.define(ITowerMergeTool, TowerMergeTool);
      reg.define(ITowerTeardownTool, TowerTeardownTool);
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

  it('falls back to the base requested when tower mode was enabled', async () => {
    await git(repo, 'branch', 'develop');
    towerActive = true;
    towerRequestedBase = 'develop';

    const result = await run(ix.get(ITowerInitTool), {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('base branch: develop');
    const state = await new TowerStore(repo).load();
    expect(state.base).toBe('develop');
  });

  it('prefers an explicit base over the requested one', async () => {
    await git(repo, 'branch', 'develop');
    towerActive = true;
    towerRequestedBase = 'main';

    const result = await run(ix.get(ITowerInitTool), { base: 'develop' });

    expect(result.isError).toBeFalsy();
    const state = await new TowerStore(repo).load();
    expect(state.base).toBe('develop');
  });

  it('reports an ignored base when re-initializing with a different one', async () => {
    await git(repo, 'branch', 'develop');
    await initViaTool();

    const second = await run(ix.get(ITowerInitTool), { base: 'develop' });

    expect(second.isError).toBeFalsy();
    expect(second.output).toContain('requested base "develop" ignored');
    const state = await new TowerStore(repo).load();
    expect(state.base).toBe('main');
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
});

describe('TowerSendTool + TowerInboxTool', () => {
  beforeEach(async () => {
    await initViaTool();
    const store = new TowerStore(repo);
    await store.registerAgent({
      name: 'w1',
      kind: 'worker',
      agentId: 'agent-w1',
      spawnedAt: new Date().toISOString(),
    });
    await store.registerAgent({
      name: 'w2',
      kind: 'worker',
      agentId: 'agent-w2',
      spawnedAt: new Date().toISOString(),
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
});

describe('TowerStatusTool', () => {
  it('renders the dashboard including the rate-limiter concurrency section', async () => {
    await initViaTool();

    const result = await run(ix.get(ITowerStatusTool), {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('# Tower status — base: main (mode: branch), you are: tower');
    expect(result.output).toContain('(no missions planned — use TowerPlan)');
    expect(result.output).toContain('budget: 2 agent(s) · inflight: 0 · spawns open');
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
    expect(result.output).toContain('Agent(resume="agent-w1", run_in_background=true');
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
    expect(result.output).toContain(`next: resume w1 with this review file (${review!.file})`);
    expect(result.output).toContain('Agent(resume="agent-w1", run_in_background=true');
    expect(result.output).not.toContain('merge-ready');
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
    expect(result.output).not.toContain('resume w1');
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
    expect(result.output).toContain('next: no worker on record owns feat/build-engine');
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

    const result = await run(ix.get(ITowerMergeTool), { branch: 'feat/survey-engine' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('read-only survey');
    expect(result.output).toContain('ready for TowerTeardown');
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
