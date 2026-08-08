/**
 * Tower tool tests against real on-disk git repositories (mkdtemp fixture,
 * same pattern as test/agent/tower/store.test.ts). Tools are resolved by
 * their interface through a TestInstantiationService with the real protocol
 * store on disk and plain stubs for the ambient services (session/agent
 * scope context, tower mode, profile, rate limiter).
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import { IAgentTowerService, TOWER_TOOL_NAMES } from '#/agent/tower/tower';
import { ITowerRateLimitService } from '#/agent/tower/towerRateLimit';
import { TowerStore } from '#/agent/tower/protocol/index';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ExecutableTool } from '#/tool/toolContract';

import { ITowerInitTool } from '#/agent/tools/tower/init/init';
import { TowerInitTool } from '#/agent/tools/tower/init/initTool';
import { ITowerPlanTool } from '#/agent/tools/tower/plan/plan';
import { TowerPlanTool } from '#/agent/tools/tower/plan/planTool';
import { ITowerMergeTool } from '#/agent/tools/tower/merge/merge';
import { TowerMergeTool } from '#/agent/tools/tower/merge/mergeTool';
import { ITowerTeardownTool } from '#/agent/tools/tower/teardown/teardown';
import { TowerTeardownTool } from '#/agent/tools/tower/teardown/teardownTool';
import { ITowerSendTool } from '#/agent/tools/tower/send/send';
import { TowerSendTool } from '#/agent/tools/tower/send/sendTool';
import { ITowerInboxTool } from '#/agent/tools/tower/inbox/inbox';
import { TowerInboxTool } from '#/agent/tools/tower/inbox/inboxTool';
import { ITowerFindingTool } from '#/agent/tools/tower/finding/finding';
import { TowerFindingTool } from '#/agent/tools/tower/finding/findingTool';
import { ITowerReviewTool } from '#/agent/tools/tower/review/review';
import { TowerReviewTool } from '#/agent/tools/tower/review/reviewTool';
import { ITowerMissionTool } from '#/agent/tools/tower/mission/mission';
import { TowerMissionTool } from '#/agent/tools/tower/mission/missionTool';
import { ITowerStatusTool } from '#/agent/tools/tower/status/status';
import { TowerStatusTool } from '#/agent/tools/tower/status/statusTool';

import { executeTool } from '../../../tools/fixtures/execute-tool';

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
let activateToolsCalls: string[][];

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'tower-tools-test-'));
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'tower-test@example.com');
  await git(repo, 'config', 'user.name', 'Tower Test');
  await commitFile(repo, 'README.md', '# fixture\n', 'initial');

  towerActive = false;
  currentAgentId = 'main';
  activateToolsCalls = [];

  disposables = new DisposableStore();
  ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.defineInstance(ISessionContext, {
        _serviceBrand: undefined,
        sessionId: 'session-test',
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
        scope: (subKey?: string) => subKey ?? '',
      });
      reg.defineInstance(IAgentTowerService, {
        _serviceBrand: undefined,
        get isActive() {
          return towerActive;
        },
        enter: () => {
          towerActive = true;
        },
        exit: () => {
          towerActive = false;
        },
      });
      reg.definePartialInstance(IAgentProfileService, {
        activateTools: (names: readonly string[]) => {
          activateToolsCalls.push([...names]);
        },
      });
      reg.definePartialInstance(ITowerRateLimitService, {
        snapshot: () => ({ budget: 2, inflight: 0, blockedUntil: null }),
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
  const result = await run(ix.get(ITowerInitTool), {});
  expect(result.isError).toBeFalsy();
  return result;
}

describe('TowerInitTool', () => {
  it('creates .tower, enters tower mode, and activates the tower tool set', async () => {
    const result = await run(ix.get(ITowerInitTool), {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('tower workspace initialized');
    expect(result.output).toContain('base branch: main');
    expect((await stat(join(repo, '.tower/comms'))).isDirectory()).toBe(true);
    expect(towerActive).toBe(true);
    expect(activateToolsCalls).toEqual([[...TOWER_TOOL_NAMES]]);
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
    expect(activateToolsCalls).toHaveLength(2);
  });
});

describe('TowerPlanTool', () => {
  it('refuses when tower mode is inactive', async () => {
    const result = await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'engine', scope: ['src/engine/**'] }],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe('tower mode is not active — run TowerInit first');
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
});

describe('TowerTeardownTool', () => {
  it('tears down the workspace and exits tower mode', async () => {
    await initViaTool();

    const result = await run(ix.get(ITowerTeardownTool), {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('tower teardown:');
    expect(result.output).toContain('Tower mode exited.');
    expect(towerActive).toBe(false);
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
});

describe('tool registration', () => {
  const MAIN_ONLY = ['TowerInit', 'TowerPlan', 'TowerMerge', 'TowerTeardown'];
  const SHARED = ['TowerSend', 'TowerInbox', 'TowerFinding', 'TowerReview', 'TowerMission', 'TowerStatus'];

  it('gates init/plan/merge/teardown to the main agent and shares the rest', () => {
    const contributions = getAgentToolContributions();
    for (const name of MAIN_ONLY) {
      const contribution = contributions.find((c) => c.options.name === name);
      expect(contribution, name).toBeDefined();
      expect(contribution?.options.when, name).toBeDefined();
      currentAgentId = 'main';
      expect(contribution?.options.when?.(ix), name).toBe(true);
      currentAgentId = 'agent-w1';
      expect(contribution?.options.when?.(ix), name).toBe(false);
    }
    currentAgentId = 'main';
    for (const name of SHARED) {
      const contribution = contributions.find((c) => c.options.name === name);
      expect(contribution, name).toBeDefined();
      expect(contribution?.options.when, name).toBeUndefined();
    }
  });
});
