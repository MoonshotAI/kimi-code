import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_REVIEW_ROUNDS,
  STATE_FILE,
  TowerProtocolError,
  TowerStore,
  branchExists,
  commitPaths,
  isAncestor,
  isWorktreeDirty,
  mergeNoFf,
  parseFrontmatter,
  scopesOverlap,
  worktreeAddNewBranch,
} from '../../../src/features/tower/protocol';
import type {
  TowerFindingType,
  TowerMission,
  TowerRosterEntry,
  TowerState,
} from '../../../src/features/tower/protocol';

const execFileAsync = promisify(execFile);

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
let store: TowerStore;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'tower-store-test-'));
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'tower-test@example.com');
  await git(repo, 'config', 'user.name', 'Tower Test');
  await commitFile(repo, 'README.md', '# fixture\n', 'initial');
  store = new TowerStore(repo);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function rosterEntry(partial: Partial<TowerRosterEntry> & Pick<TowerRosterEntry, 'name' | 'kind'>): TowerRosterEntry {
  return {
    agentId: `agent-${partial.name}`,
    spawnedAt: new Date().toISOString(),
    ...partial,
  };
}

async function setupMission(input: {
  title: string;
  scope: string;
  file: string;
  content: string;
  deps?: string[];
  status?: TowerMission['status'];
}): Promise<TowerMission> {
  const missions = await store.plan([
    { title: input.title, scope: [input.scope], deps: input.deps },
  ]);
  const mission = missions[0]!;
  const state = await store.load();
  await store.addWorktree(mission.worktree, mission.branch, state.base);
  await commitFile(worktreeOf(mission), input.file, input.content, `work on ${mission.id}`);
  await store.updateMission(
    'tower',
    mission.id,
    { status: input.status ?? 'completed' },
    { silent: true },
  );
  return mission;
}

function worktreeOf(mission: TowerMission): string {
  return store.abs(join('.tower/worktrees', mission.worktree));
}

async function spliceMissionIntoState(mission: TowerMission): Promise<void> {
  const file = store.abs(STATE_FILE);
  const state = JSON.parse(await readFile(file, 'utf8')) as TowerState;
  state.missions.push(mission);
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

async function completeMission(mission: TowerMission): Promise<void> {
  await store.updateMission('tower', mission.id, { status: 'completed' }, { silent: true });
}

async function cleanReview(reviewer: string, target: string): Promise<void> {
  await store.submitReview(reviewer, {
    target,
    status: 'clean',
    merge: 'merge',
    findings: 'none',
    checks: ['tests pass'],
    decision: 'looks good',
  });
}

describe('init in a non-git directory', () => {
  it('bootstraps an empty directory with git init and an empty initial commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tower-store-nogit-empty-'));
    try {
      const result = await new TowerStore(dir).init('session-a');
      const branch = await git(dir, 'symbolic-ref', '--short', 'HEAD');
      expect(result).toMatchObject({ base: branch, created: true, checkout: branch });
      expect(await git(dir, 'rev-list', '--count', 'HEAD')).toBe('1');
      expect(await git(dir, 'log', '-1', '--format=%s')).toBe('tower: init');
      expect(await git(dir, 'status', '--porcelain')).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('snapshots the existing files of a non-empty directory onto the requested base', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tower-store-nogit-dirty-'));
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'app.ts'), 'export {}\n');
      await writeFile(join(dir, 'README.md'), '# scratch\n');
      const result = await new TowerStore(dir).init('session-a', 'tower-base');
      expect(result).toMatchObject({ base: 'tower-base', created: true, checkout: 'tower-base' });
      expect(await git(dir, 'log', '-1', '--format=%s')).toBe(
        'tower: snapshot of uncommitted base checkout changes (base tower-base)',
      );
      expect(await git(dir, 'ls-files')).toContain('src/app.ts');
      expect(await git(dir, 'status', '--porcelain')).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('init', () => {
  it('creates the directory skeleton, state.json, and the git exclude entry', async () => {
    const result = await store.init();
    expect(result).toEqual({
      base: 'main',
      created: true,
      retiredAgents: [],
      checkout: 'main',
      openMissions: [],
    });

    for (const sub of ['inbox', 'findings', 'reviews', 'missions', 'log']) {
      expect((await stat(join(repo, '.tower/comms', sub))).isDirectory()).toBe(true);
    }
    expect((await stat(join(repo, '.tower/worktrees'))).isDirectory()).toBe(true);
    expect((await stat(join(repo, '.tower/comms/log/activity.log'))).isFile()).toBe(true);
    expect((await stat(join(repo, '.tower/comms/MISSIONS.md'))).isFile()).toBe(true);

    const state = JSON.parse(
      await readFile(join(repo, '.tower/comms/state.json'), 'utf8'),
    ) as TowerState;
    expect(state.version).toBe(1);
    expect(state.base).toBe('main');
    expect(state.roster.agents).toEqual([]);
    expect(state.missions).toEqual([]);

    const exclude = await readFile(join(repo, '.git/info/exclude'), 'utf8');
    expect(exclude.split('\n').map((line) => line.trim())).toContain('.tower/');
  });

  it('is idempotent — a second init reports created:false and preserves state', async () => {
    await store.init();
    await store.plan([{ title: 'kept mission', scope: ['src/kept/**'] }]);

    const second = await store.init();
    expect(second).toEqual({
      base: 'main',
      created: false,
      retiredAgents: [],
      checkout: 'main',
      openMissions: ['M1'],
    });
    const state = await store.load();
    expect(state.missions).toHaveLength(1);
  });

  it('keeps the roster on a same-session re-init', async () => {
    await store.init('session-a');
    await store.registerAgent(rosterEntry({ name: 'agent-build', kind: 'worker', sessionId: 'session-a' }));

    const second = await store.init('session-a');

    expect(second).toEqual({
      base: 'main',
      created: false,
      retiredAgents: [],
      checkout: 'main',
      openMissions: [],
    });
    const state = await store.load();
    expect(state.roster.agents.map((agent) => agent.name)).toEqual(['agent-build']);
  });

  it('retires a foreign session\'s roster on adopt and logs the session boundary', async () => {
    await store.init('session-a');
    await store.plan([{ title: 'kept mission', scope: ['src/kept/**'] }]);
    await store.registerAgent(rosterEntry({ name: 'agent-build', kind: 'worker', sessionId: 'session-a' }));
    await store.registerAgent(rosterEntry({ name: 'reviewer-a', kind: 'reviewer', sessionId: 'session-a' }));

    const second = await store.init('session-b');

    expect(second).toEqual({
      base: 'main',
      created: false,
      retiredAgents: ['agent-build', 'reviewer-a'],
      checkout: 'main',
      openMissions: ['M1'],
    });
    const state = await store.load();
    expect(state.sessionId).toBe('session-b');
    expect(state.roster.agents).toEqual([]);
    expect(state.missions).toHaveLength(1);
    const log = await store.recentLog(5);
    expect(log.some((line) => line.includes(' adopt ') && line.includes('session=session-b') && line.includes('previous=session-a') && line.includes('retired=agent-build,reviewer-a'))).toBe(true);
  });

  it('rejects reserved protocol names on roster registration', async () => {
    await store.init('session-a');

    await expect(
      store.registerAgent(rosterEntry({ name: 'tower', kind: 'worker', sessionId: 'session-a' })),
    ).rejects.toThrow(/name "tower" is reserved/);
    await expect(
      store.registerAgent(rosterEntry({ name: 'all', kind: 'reviewer', sessionId: 'session-a' })),
    ).rejects.toThrow(/name "all" is reserved/);
    expect((await store.load()).roster.agents).toEqual([]);
  });

  it('rejects blank or whitespace-padded names on roster registration', async () => {
    await store.init('session-a');

    await expect(
      store.registerAgent(rosterEntry({ name: ' tower ', kind: 'worker', sessionId: 'session-a' })),
    ).rejects.toThrow(/whitespace/);
    await expect(
      store.registerAgent(rosterEntry({ name: 'w1 ', kind: 'worker', sessionId: 'session-a' })),
    ).rejects.toThrow(/whitespace/);
    expect((await store.load()).roster.agents).toEqual([]);
  });

  it('records an explicit local base branch instead of the checked-out one', async () => {
    await git(repo, 'branch', 'develop');

    const result = await store.init(undefined, 'develop');

    expect(result).toEqual({
      base: 'develop',
      created: true,
      retiredAgents: [],
      checkout: 'main',
      openMissions: [],
    });
    const state = await store.load();
    expect(state.base).toBe('develop');
  });

  it('rejects a base that is not a local branch and stays uninitialized', async () => {
    await expect(store.init(undefined, 'origin/main')).rejects.toThrow(
      /base branch "origin\/main" does not exist as a local branch/,
    );
    await expect(store.init(undefined, 'no-such-branch')).rejects.toThrow(
      /base branch "no-such-branch" does not exist as a local branch/,
    );

    expect(await store.isInitialized()).toBe(false);
  });

  it('allows a detached HEAD when the base is given explicitly', async () => {
    await git(repo, 'checkout', '--detach', 'HEAD');

    const result = await store.init(undefined, 'main');

    expect(result).toEqual({
      base: 'main',
      created: true,
      retiredAgents: [],
      checkout: 'HEAD',
      openMissions: [],
    });
  });

  it('refuses a detached HEAD without an explicit base', async () => {
    await git(repo, 'checkout', '--detach', 'HEAD');

    await expect(store.init()).rejects.toThrow(/detached HEAD/);
    expect(await store.isInitialized()).toBe(false);
  });

  it('re-anchors the base on re-init with an explicit different one', async () => {
    await git(repo, 'branch', 'develop');
    await store.init();

    const second = await store.init(undefined, 'develop');

    expect(second).toEqual({
      base: 'develop',
      created: false,
      retiredAgents: [],
      checkout: 'main',
      rebasedFrom: 'main',
      rebaseDigest: {
        from: 'main',
        to: 'develop',
        baseTip: await git(repo, 'rev-parse', 'develop'),
        missions: [],
      },
      openMissions: [],
    });
    const state = await store.load();
    expect(state.base).toBe('develop');
  });
});

describe('release', () => {
  it('clears the recorded owner and logs the release when the session matches', async () => {
    await store.init('session-a');

    await store.release('session-a');

    const state = await store.load();
    expect(state.sessionId).toBeUndefined();
    const log = await store.recentLog(5);
    expect(log.some((line) => line.includes(' release ') && line.includes('session=session-a'))).toBe(true);
  });

  it('keeps the recorded owner for a different session and logs nothing', async () => {
    await store.init('session-a');

    await store.release('session-b');

    const state = await store.load();
    expect(state.sessionId).toBe('session-a');
    const log = await store.recentLog(5);
    expect(log.some((line) => line.includes(' release '))).toBe(false);
  });

  it('is a no-op while the workspace is not initialized', async () => {
    await store.release('session-a');

    expect(await store.isInitialized()).toBe(false);
  });

  it('is idempotent once ownership is already released', async () => {
    await store.init('session-a');
    await store.release('session-a');

    await store.release('session-a');

    expect((await store.load()).sessionId).toBeUndefined();
    const log = await store.recentLog(10);
    expect(log.filter((line) => line.includes(' release '))).toHaveLength(1);
  });

  it('lets another session adopt the workspace after the owner released it', async () => {
    await store.init('session-a');
    await store.release('session-a');

    const result = await store.init('session-b');

    expect(result.created).toBe(false);
    expect(result.retiredAgents).toEqual([]);
    expect((await store.load()).sessionId).toBe('session-b');
  });
});

describe('state loss degradation', () => {
  async function destroyComms(): Promise<void> {
    await rm(join(repo, '.tower/comms'), { recursive: true, force: true });
  }

  it('reports never-initialized (not state-lost) when .tower never existed', async () => {
    expect(await store.isInitialized()).toBe(false);
    expect(await store.isStateLost()).toBe(false);
    await expect(store.load()).rejects.toThrow(
      'tower is not initialized in this repository — run TowerInit first',
    );
    await expect(store.loadOrRecover()).rejects.toThrow(
      'tower is not initialized in this repository — run TowerInit first',
    );
    await expect(store.merge('feat/x')).rejects.toThrow(
      'tower is not initialized in this repository — run TowerInit first',
    );
  });

  it('detects state loss when comms is deleted but .tower survives', async () => {
    await store.init();
    await destroyComms();

    expect(await store.isInitialized()).toBe(false);
    expect(await store.isStateLost()).toBe(true);
    await expect(store.load()).rejects.toThrow('tower state was lost');
    await expect(store.load()).rejects.not.toThrow('not initialized');
  });

  it('refuses locked mutations like merge and rebaseMission with an explicit state-lost error, recovering nothing', async () => {
    await store.init();
    const mission = await setupMission({
      title: 'engine work',
      scope: 'src/engine/**',
      file: 'src/engine/a.ts',
      content: 'export {}\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await cleanReview('rev', mission.branch);
    await destroyComms();

    await expect(store.merge(mission.branch)).rejects.toThrow('tower state was lost');
    await expect(store.merge(mission.branch)).rejects.not.toThrow('not initialized');
    await expect(store.rebaseMission('tower', mission.id)).rejects.toThrow('tower state was lost');

    expect(await store.isInitialized()).toBe(false);
    expect(await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('recovers a minimal state stamped recoveredAt with the current checkout branch as base', async () => {
    await store.init();
    await git(repo, 'checkout', '-b', 'hotfix');
    await destroyComms();

    const state = await store.loadOrRecover();

    expect(state.base).toBe('hotfix');
    expect(state.mode).toBe('branch');
    expect(state.recoveredAt).toBeTruthy();
    expect(state.missions).toEqual([]);
    expect(state.roster.agents).toEqual([]);
    for (const sub of ['inbox', 'findings', 'reviews', 'missions', 'log']) {
      expect((await stat(join(repo, '.tower/comms', sub))).isDirectory()).toBe(true);
    }
    expect((await stat(join(repo, '.tower/comms/MISSIONS.md'))).isFile()).toBe(true);
    const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(log).toContain('state.recovered');
    expect(log).toContain('base=hotfix');

    expect((await store.load()).recoveredAt).toBe(state.recoveredAt);
    expect((await store.loadOrRecover()).recoveredAt).toBe(state.recoveredAt);
  });

  it('recovers exactly once under concurrent loadOrRecover calls', async () => {
    await store.init();
    await destroyComms();

    const [a, b] = await Promise.all([store.loadOrRecover(), store.loadOrRecover()]);

    expect(a.recoveredAt).toBeTruthy();
    expect(a.recoveredAt).toBe(b.recoveredAt);
  });

  it('registers a placeholder roster entry for an unknown caller of a recovered state', async () => {
    await store.init();
    await destroyComms();
    const recovered = await store.loadOrRecover();

    const resolved = await store.resolveMessagingCaller(recovered, 'agent-99');

    expect(resolved.caller).toBe('agent-99');
    expect(resolved.placeholder).toBe(true);
    expect(resolved.state.roster.agents).toEqual([
      expect.objectContaining({
        name: 'agent-99',
        agentId: 'agent-99',
        kind: 'worker',
        spawnedAt: recovered.recoveredAt,
      }),
    ]);
    const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(log).toContain('roster.placeholder');

    const again = await store.resolveMessagingCaller(resolved.state, 'agent-99');
    expect(again.caller).toBe('agent-99');
    expect(again.placeholder).toBeUndefined();
    expect((await store.load()).roster.agents).toHaveLength(1);

    const asTower = await store.resolveMessagingCaller(resolved.state, 'main');
    expect(asTower.caller).toBe('tower');
    expect(asTower.placeholder).toBeUndefined();
  });

  it('still rejects unknown callers when the state was never recovered', async () => {
    await store.init();

    await expect(store.resolveMessagingCaller(await store.load(), 'agent-99')).rejects.toThrow(
      'not a tower participant',
    );
  });

  it('delivers a degraded TowerComplete report without marking any mission completed', async () => {
    await store.init();
    await destroyComms();
    const recovered = await store.loadOrRecover();
    const { caller } = await store.resolveMessagingCaller(recovered, 'agent-99');

    const result = await store.complete(caller, 'the work is done — full details');

    expect(result.mission).toBeUndefined();
    expect(result.recoveredAt).toBe(recovered.recoveredAt);
    expect(result.notificationCreated).toBe(true);
    expect(result.message?.item).toMatchObject({
      from: 'agent-99',
      to: 'tower',
      subject: 'completion-report-state-lost',
      body: 'the work is done — full details',
    });

    const retry = await store.complete(caller, 'the work is done — full details');
    expect(retry.notificationCreated).toBe(false);
    expect(retry.message?.item.file).toBe(result.message?.item.file);

    expect((await store.load()).missions).toEqual([]);
  });
});

describe('markAgentDied', () => {
  it('marks the roster entry and appends an activity log line', async () => {
    await store.init('session-a');
    const missions = await store.plan([{ title: 'engine', scope: ['src/engine/**'] }]);
    const mission = missions[0]!;
    await store.registerAgent(
      rosterEntry({ name: 'w1', kind: 'worker', agentId: 'agent-w1', missionId: mission.id }),
    );

    const entry = await store.markAgentDied('agent-w1', 'failed', 'provider blew up\nstack line');

    expect(entry?.diedAt).toBeDefined();
    expect(entry?.deathStatus).toBe('failed');
    expect(entry?.deathReason).toBe('provider blew up\nstack line');
    const state = await store.load();
    expect(state.roster.agents[0]?.diedAt).toBe(entry?.diedAt);
    const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    const diedLine = log.split('\n').find((line) => line.includes(' died '));
    expect(diedLine).toBeDefined();
    expect(diedLine).toContain('name=w1');
    expect(diedLine).toContain('agent=agent-w1');
    expect(diedLine).toContain('status=failed');
    expect(diedLine).toContain('reason=provider blew up stack line');
    expect(diedLine).toContain(`mission=${mission.id}`);
    expect(diedLine).toContain('ref=');
    expect(diedLine).toContain(mission.id);
  });

  it('is a no-op for unknown or already-dead agents', async () => {
    await store.init('session-a');
    await store.registerAgent(rosterEntry({ name: 'w1', kind: 'worker', agentId: 'agent-w1' }));

    expect(await store.markAgentDied('agent-ghost', 'failed')).toBeUndefined();

    const first = await store.markAgentDied('agent-w1', 'failed', 'first');
    const second = await store.markAgentDied('agent-w1', 'timed_out', 'second');
    expect(second?.diedAt).toBe(first?.diedAt);
    expect(second?.deathStatus).toBe('failed');
    expect(second?.deathReason).toBe('first');
  });

  it('clearAgentDied removes the death mark and logs the revival', async () => {
    await store.init('session-a');
    await store.registerAgent(rosterEntry({ name: 'w1', kind: 'worker', agentId: 'agent-w1' }));
    await store.markAgentDied('agent-w1', 'failed', 'boom');

    expect(await store.clearAgentDied('agent-w1')).toBe(true);
    expect(await store.clearAgentDied('agent-w1')).toBe(false);
    expect(await store.clearAgentDied('agent-ghost')).toBe(false);

    const state = await store.load();
    expect(state.roster.agents[0]?.diedAt).toBeUndefined();
    expect(state.roster.agents[0]?.deathStatus).toBeUndefined();
    expect(state.roster.agents[0]?.deathReason).toBeUndefined();
    const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    const revivedLine = log.split('\n').find((line) => line.includes(' revived '));
    expect(revivedLine).toBeDefined();
    expect(revivedLine).toContain('name=w1');
    expect(revivedLine).toContain('agent=agent-w1');
  });

  it('ignores died/revived writes from a session that does not own the store', async () => {
    await store.init('session-a');
    await store.registerAgent(rosterEntry({ name: 'w1', kind: 'worker', agentId: 'agent-w1' }));

    expect(await store.markAgentDied('agent-w1', 'failed', 'boom', 'session-b')).toBeUndefined();
    let state = await store.load();
    expect(state.roster.agents[0]?.diedAt).toBeUndefined();

    await store.markAgentDied('agent-w1', 'failed', 'boom', 'session-a');
    state = await store.load();
    expect(state.roster.agents[0]?.diedAt).toBeDefined();

    expect(await store.clearAgentDied('agent-w1', 'session-b')).toBe(false);
    state = await store.load();
    expect(state.roster.agents[0]?.diedAt).toBeDefined();

    expect(await store.clearAgentDied('agent-w1', 'session-a')).toBe(true);
    const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(log.split('\n').filter((line) => line.includes(' died '))).toHaveLength(1);
    expect(log.split('\n').filter((line) => line.includes(' revived '))).toHaveLength(1);
  });
});

describe('rebase', () => {
  it('switches the recorded base and logs it when no missions are open', async () => {
    await git(repo, 'branch', 'develop');
    await store.init('session-a', 'main');

    await store.rebase('develop');

    expect((await store.load()).base).toBe('develop');
    const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(log).toContain('rebase');
    expect(log).toContain('from=main');
    expect(log).toContain('to=develop');
  });

  it('re-anchors even while missions are open and logs the open count', async () => {
    await git(repo, 'branch', 'develop');
    await store.init('session-a', 'main');
    await store.plan([{ title: 'engine', scope: ['src/engine/**'] }]);

    await store.rebase('develop');

    const state = await store.load();
    expect(state.base).toBe('develop');
    expect(state.missions).toHaveLength(1);
    const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(log).toContain('rebase');
    expect(log).toContain('open_missions=1');
  });

  it('returns exact per-mission re-anchor relations and branch tips', async () => {
    await store.init('session-a', 'main');
    const [current, stale, planned] = await store.plan([
      { title: 'current work', scope: ['src/current/**'] },
      { title: 'stale work', scope: ['src/stale/**'] },
      { title: 'planned work', scope: ['src/planned/**'] },
    ]);
    const state = await store.load();
    await store.addWorktree(current!.worktree, current!.branch, state.base);
    await store.addWorktree(stale!.worktree, stale!.branch, state.base);
    await commitFile(worktreeOf(current!), 'src/current/current.ts', 'current\n', 'current work');
    await commitFile(worktreeOf(stale!), 'src/stale/stale.ts', 'stale\n', 'stale work');
    await git(repo, 'branch', '-f', 'develop', current!.branch);

    const digest = await store.rebase('develop');

    expect(digest).toEqual({
      from: 'main',
      to: 'develop',
      baseTip: await git(repo, 'rev-parse', current!.branch),
      missions: [
        {
          id: current!.id,
          branch: current!.branch,
          relation: 'up-to-date',
          branchTip: await git(repo, 'rev-parse', current!.branch),
        },
        {
          id: stale!.id,
          branch: stale!.branch,
          relation: 'stale',
          branchTip: await git(repo, 'rev-parse', stale!.branch),
        },
        { id: planned!.id, branch: planned!.branch, relation: 'no-branch' },
      ],
    });
    expect((await store.load()).base).toBe('develop');
  });

  it('does not save a new base when a required mission observation fails', async () => {
    await git(repo, 'branch', 'develop');
    await store.init('session-a', 'main');
    await store.plan([{ title: 'broken observation', scope: ['src/broken/**'] }]);
    await writeFile(join(repo, '.git/refs/heads/broken'), `${'0'.repeat(40)}\n`);
    const state = await store.load();
    state.missions[0] = { ...state.missions[0]!, branch: 'broken' };
    await writeFile(store.abs(STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);

    await expect(store.rebase('develop')).rejects.toThrow();

    expect((await store.load()).base).toBe('main');
  });

  it('rejects a base that is not a local branch', async () => {
    await store.init('session-a', 'main');

    await expect(store.rebase('develop')).rejects.toThrow('does not exist as a local branch');
    expect((await store.load()).base).toBe('main');
  });
});

describe('plan', () => {
  beforeEach(async () => {
    await store.init();
  });

  it('writes missions to state and renders MISSIONS.md plus mission files', async () => {
    const missions = await store.plan([
      { title: 'Build engine', scope: ['src/engine/**'], tasks: ['scaffold', 'implement'] },
      { title: 'Build UI', scope: ['src/ui/**'], deps: ['M1'] },
    ]);
    expect(missions.map((m) => m.id)).toEqual(['M1', 'M2']);
    expect(missions[0]).toMatchObject({
      title: 'Build engine',
      branch: 'feat/build-engine',
      worktree: 'wt-1',
      status: 'planned',
    });
    expect(missions[1]!.deps).toEqual(['M1']);

    const index = await readFile(join(repo, '.tower/comms/MISSIONS.md'), 'utf8');
    expect(index).toContain('| M1 | Build engine | feat/build-engine | wt-1 |');
    expect(index).toContain('| M2 | Build UI | feat/build-ui | wt-2 |');
    expect(index).toContain('M1 → M2');
    expect(index).toContain('- M1: src/engine/**');

    const missionFile = await readFile(
      join(repo, '.tower/comms/missions/M1-build-engine.md'),
      'utf8',
    );
    expect(missionFile).toContain('# Mission M1: Build engine');
    expect(missionFile).toContain('- [ ] scaffold');
    expect(missionFile).toContain('- [ ] implement');
  });

  it('carries the mission context into state and renders it in the mission file', async () => {
    const [mission] = await store.plan([
      {
        title: 'Build engine',
        scope: ['src/engine/**'],
        tasks: ['scaffold'],
        context: 'Make it fast, not fancy. The CLI must stay a single binary.',
      },
    ]);
    expect(mission?.context).toBe('Make it fast, not fancy. The CLI must stay a single binary.');
    expect((await store.load()).missions[0]?.context).toBe(
      'Make it fast, not fancy. The CLI must stay a single binary.',
    );

    const missionFile = await readFile(
      join(repo, '.tower/comms/missions/M1-build-engine.md'),
      'utf8',
    );
    expect(missionFile).toContain("## Context — the user's own words, verbatim");
    expect(missionFile).toContain('Make it fast, not fancy. The CLI must stay a single binary.');
  });

  it('records no context and renders no Context section when the plan omits it', async () => {
    await store.plan([{ title: 'Build engine', scope: ['src/engine/**'] }]);

    expect((await store.load()).missions[0]?.context).toBeUndefined();
    const missionFile = await readFile(
      join(repo, '.tower/comms/missions/M1-build-engine.md'),
      'utf8',
    );
    expect(missionFile).not.toContain('## Context');
  });

  it('serializes overlapping scopes with an auto dependency instead of rejecting them', async () => {
    const missions = await store.plan([
      { title: 'outer', scope: ['src/a/**'] },
      { title: 'inner', scope: ['src/a/b/**'] },
    ]);
    expect(missions.map((m) => m.id)).toEqual(['M1', 'M2']);
    expect(missions[1]!.deps).toEqual(['M1']);
    expect(missions[1]!.notes.join('\n')).toContain('auto dependency on M1');

    const index = await readFile(join(repo, '.tower/comms/MISSIONS.md'), 'utf8');
    expect(index).toContain('M1 → M2');
  });

  it('rejects whole-repo scopes', async () => {
    const patterns = ['**', '**/', '**/*', '*'];
    for (const [i, raw] of patterns.entries()) {
      await expect(store.plan([{ title: `everything ${i}`, scope: [raw] }])).rejects.toThrow(
        /covers the whole repo/,
      );
    }
  });

  it('auto-dependencies on overlap chain transitively and gate the merge order', async () => {
    const first = await setupMission({
      title: 'first config',
      scope: 'config/**',
      file: 'config/settings.go',
      content: 'package config\n',
    });
    const second = await setupMission({
      title: 'second config',
      scope: 'config/**',
      file: 'config/settings.go',
      content: 'package config\n// second\n',
    });
    expect(second.deps).toEqual([first.id]);

    await store.registerAgent(
      rosterEntry({ name: 'rev-2', kind: 'reviewer', reviewTarget: second.branch }),
    );
    await cleanReview('rev-2', second.branch);
    await expect(store.merge(second.branch)).rejects.toThrow(
      new RegExp(`dependencies not merged yet \\(${first.id}\\)`),
    );
  });

  it('rejects deps referencing unknown missions', async () => {
    await expect(
      store.plan([{ title: 'a', scope: ['src/a/**'], deps: ['M9'] }]),
    ).rejects.toThrow(/depends on unknown mission "M9"/);
  });

  it('lets new missions reuse the scope of an already-merged mission', async () => {
    const [survey] = await store.plan([{ title: 'survey', scope: ['src/a/**'], kind: 'survey' }]);
    const state = await store.load();
    await store.addWorktree(survey!.worktree, survey!.branch, state.base);
    await completeMission(survey!);
    await store.merge(survey!.branch);

    const missions = await store.plan([{ title: 'implement', scope: ['src/a/b/**'] }]);
    expect(missions[0]?.id).toBe('M2');
    expect(missions[0]?.deps).toEqual([]);

    const [clash] = await store.plan([{ title: 'clash', scope: ['src/a/**'] }]);
    expect(clash!.deps).toEqual(['M2']);
  });

  it('survey missions reserve no scope and may overlap builds and each other', async () => {
    const missions = await store.plan([
      { title: 'scan layer apis', scope: ['src/layer/**'], kind: 'survey' },
      { title: 'scan core apis', scope: ['src/**'], kind: 'survey' },
      { title: 'implement gemm', scope: ['src/layer/vulkan/**'] },
    ]);
    expect(missions.map((m) => m.kind)).toEqual(['survey', 'survey', 'build']);

    const [overlap] = await store.plan([
      { title: 'touch layers too', scope: ['src/layer/vulkan/shader/**'] },
    ]);
    expect(overlap!.deps).toEqual(['M3']);
  });

  it('rejects a new mission whose slugged branch collides with an existing mission, even a closed one', async () => {
    await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    await store.updateMission('tower', 'M1', { status: 'abandoned' });

    await expect(store.plan([{ title: 'Feature X', scope: ['src/y/**'] }])).rejects.toThrow(
      /branch "feat\/feature-x" is already used by M1.*change the title/,
    );
    expect((await store.load()).missions).toHaveLength(1);
  });

  it('rejects duplicate slugged branches within a single plan batch', async () => {
    await expect(
      store.plan([
        { title: 'feature x', scope: ['src/x/**'] },
        { title: 'Feature X!', scope: ['src/y/**'] },
      ]),
    ).rejects.toThrow(/branch "feat\/feature-x" is already used by M1/);
    expect((await store.load()).missions).toHaveLength(0);
  });

  it('rejects a new mission whose slugged branch exists in git without a mission record', async () => {
    await git(repo, 'branch', 'feat/feature-x');

    await expect(store.plan([{ title: 'feature x', scope: ['src/x/**'] }])).rejects.toThrow(
      /branch "feat\/feature-x" already exists in git.*not owned by any tower mission/s,
    );
    expect((await store.load()).missions).toHaveLength(0);
  });

  it('rejects titles containing non-ASCII characters and names the first offender', async () => {
    await expect(
      store.plan([{ title: '航运市场B010100迁移', scope: ['src/x/**'] }]),
    ).rejects.toThrow(/contains non-ASCII characters \(first: "航"\)/);
    expect((await store.load()).missions).toHaveLength(0);
  });

  it('rejects a batch when any title contains non-ASCII characters, even mixed with ASCII ones', async () => {
    await expect(
      store.plan([
        { title: 'Build engine', scope: ['src/engine/**'] },
        { title: '金融市场B010400迁移', scope: ['src/finance/**'] },
      ]),
    ).rejects.toThrow(/contains non-ASCII characters/);
    expect((await store.load()).missions).toHaveLength(0);
  });

  it('rejects Russian and Korean titles — they slug to the same generic word as CJK', async () => {
    await expect(
      store.plan([{ title: 'Исправить ошибку входа', scope: ['src/x/**'] }]),
    ).rejects.toThrow(/contains non-ASCII characters \(first: "И"\)/);
    await expect(
      store.plan([{ title: '한글 제목', scope: ['src/x/**'] }]),
    ).rejects.toThrow(/contains non-ASCII characters \(first: "한"\)/);
    expect((await store.load()).missions).toHaveLength(0);
  });

  it('accepts titles with printable ASCII punctuation — dashes, underscores, spaces, plus signs', async () => {
    const missions = await store.plan([
      { title: 'fix login_error + retry-logic', scope: ['src/x/**'] },
    ]);

    expect(missions[0]?.title).toBe('fix login_error + retry-logic');
    expect(missions[0]?.branch).toBe('feat/fix-login-error-retry-logic');
  });
});

describe('inbox send', () => {
  beforeEach(async () => {
    await store.init();
    await store.registerAgent(rosterEntry({ name: 'w1', kind: 'worker' }));
  });

  it('rejects unknown recipients and lists the known names', async () => {
    await expect(store.send('tower', { to: 'ghost', subject: 'hi', body: 'x' })).rejects.toThrow(
      /known: tower, all, w1/,
    );
  });

  it('rejects messages addressed to yourself', async () => {
    await expect(store.send('tower', { to: 'tower', subject: 'hi', body: 'x' })).rejects.toThrow(
      /yourself/,
    );
    await expect(store.send('w1', { to: 'w1', subject: 'hi', body: 'x' })).rejects.toThrow(
      /yourself/,
    );
  });

  it('writes the message file with full frontmatter and logs a real ref path', async () => {
    const rel = await store.send('tower', {
      to: 'w1',
      subject: 'get started',
      body: 'please start on M1',
    });
    expect(rel).toMatch(/^\.tower[/\\]comms[/\\]inbox[/\\]/);

    const text = await readFile(join(repo, rel), 'utf8');
    const { fields, body } = parseFrontmatter(text);
    expect(fields['type']).toBe('inbox');
    expect(fields['message_id']).toBeTruthy();
    expect(fields['from']).toBe('tower');
    expect(fields['to']).toBe('w1');
    expect(fields['subject']).toBe('get started');
    expect(fields['sent_at']).toBeTruthy();
    expect(body).toBe('please start on M1');

    const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    const sendLine = log.split('\n').find((line) => line.includes('inbox.send'));
    expect(sendLine).toBeTruthy();
    const ref = /ref=(\S+)/.exec(sendLine ?? '')?.[1];
    expect(ref).toBe(rel);
    expect((await stat(join(repo, ref!))).isFile()).toBe(true);
  });

  it('stamps the sender token count into the frontmatter and the activity log', async () => {
    const rel = await store.send('tower', {
      to: 'w1',
      subject: 'get started',
      body: 'please start on M1',
      tokens: 12345,
    });

    const { fields } = parseFrontmatter(await readFile(join(repo, rel), 'utf8'));
    expect(fields['tokens']).toBe('12345');

    const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    const sendLine = log.split('\n').find((line) => line.includes('inbox.send'));
    expect(sendLine).toContain('tokens=12345');
  });

  it('records tokens as -1 when the sender usage is unavailable', async () => {
    const rel = await store.send('tower', {
      to: 'w1',
      subject: 'get started',
      body: 'please start on M1',
    });

    const { fields } = parseFrontmatter(await readFile(join(repo, rel), 'utf8'));
    expect(fields['tokens']).toBe('-1');
  });
});

describe('readInbox', () => {
  beforeEach(async () => {
    await store.init();
    await store.registerAgent(rosterEntry({ name: 'w1', kind: 'worker' }));
    await store.registerAgent(rosterEntry({ name: 'w2', kind: 'worker' }));
    await store.send('tower', { to: 'w1', subject: 'for w1', body: 'a' });
    await store.send('tower', { to: 'w2', subject: 'for w2', body: 'b' });
    await store.send('w1', { to: 'tower', subject: 'report', body: 'c' });
    await store.send('tower', { to: 'all', subject: 'broadcast', body: 'd' });
  });

  it('workers see only messages addressed to them or broadcast', async () => {
    const inbox = await store.readInbox('w1', 20);
    expect(inbox.map((item) => item.subject).toSorted()).toEqual(['broadcast', 'for w1']);
    const w2Inbox = await store.readInbox('w2', 20);
    expect(w2Inbox.map((item) => item.subject).toSorted()).toEqual(['broadcast', 'for w2']);
  });

  it('the tower sees everything', async () => {
    const inbox = await store.readInbox('tower', 20);
    expect(inbox.map((item) => item.subject).toSorted()).toEqual([
      'broadcast',
      'for w1',
      'for w2',
      'report',
    ]);
  });
});

describe('inbox read tracking', () => {
  beforeEach(async () => {
    await store.init();
  });

  async function seedOwnedMission(spawnedAt = '2026-09-20T00:00:00.000Z'): Promise<TowerMission> {
    const [mission] = await store.plan([{ title: 'feature x', scope: ['src/feature-x/**'] }]);
    const state = await store.load();
    await store.addWorktree(mission!.worktree, mission!.branch, state.base);
    await commitFile(worktreeOf(mission!), 'src/feature-x/x.ts', 'x\n', `work on ${mission!.id}`);
    await store.registerAgent(
      rosterEntry({
        name: 'w1',
        kind: 'worker',
        missionId: mission!.id,
        worktree: mission!.worktree,
        branch: mission!.branch,
        spawnedAt,
      }),
    );
    return mission!;
  }

  it('seeds lastInboxReadAt from spawnedAt at registration', async () => {
    await store.registerAgent(
      rosterEntry({ name: 'w1', kind: 'worker', spawnedAt: '2026-09-20T10:00:00.000Z' }),
    );

    expect((await store.load()).roster.agents[0]?.lastInboxReadAt).toBe(
      '2026-09-20T10:00:00.000Z',
    );
  });

  it('markInboxRead advances to the newest seen sent_at, falls back to now, and never regresses', async () => {
    await store.registerAgent(
      rosterEntry({ name: 'w1', kind: 'worker', spawnedAt: '2026-09-20T10:00:00.000Z' }),
    );

    await store.markInboxRead('w1', '2026-09-21T00:00:00.000Z');
    expect((await store.load()).roster.agents[0]?.lastInboxReadAt).toBe('2026-09-21T00:00:00.000Z');

    await store.markInboxRead('w1', '2026-09-20T12:00:00.000Z');
    expect((await store.load()).roster.agents[0]?.lastInboxReadAt).toBe('2026-09-21T00:00:00.000Z');

    await store.markInboxRead('w1');
    const at = (await store.load()).roster.agents[0]?.lastInboxReadAt;
    expect(Date.parse(at!)).toBeGreaterThan(Date.parse('2026-09-21T00:00:00.000Z'));

    await store.markInboxRead('ghost', '2030-01-01T00:00:00.000Z');
    expect((await store.load()).roster.agents).toHaveLength(1);
  });

  it('refuses a worker completion while unread inbox messages wait and names the count', async () => {
    const mission = await seedOwnedMission();
    await store.registerAgent(
      rosterEntry({ name: 'w2', kind: 'worker', spawnedAt: '2026-09-20T00:00:00.000Z' }),
    );
    await store.send('tower', { to: 'w1', subject: 'requirement change', body: 'add a poem' });
    await store.send('tower', { to: 'w1', subject: 'one more', body: 'and tests' });
    await store.send('tower', { to: 'w2', subject: 'not for w1', body: 'ignore me' });

    await expect(store.updateMission('w1', mission.id, { status: 'completed' })).rejects.toThrow(
      /cannot transition to completed — 2 unread inbox message\(s\) for w1.*call TowerInbox/s,
    );
    expect((await store.load()).missions.find((m) => m.id === mission.id)?.status).toBe('planned');
  });

  it('lets the worker complete once every returned message is acknowledged', async () => {
    const mission = await seedOwnedMission();
    await store.send('tower', { to: 'w1', subject: 'requirement change', body: 'add a poem' });

    await expect(store.updateMission('w1', mission.id, { status: 'completed' })).rejects.toThrow(
      /unread inbox message/,
    );

    const items = await store.readUnreadInbox('w1', 20);
    expect(await store.ackInbox('w1', items.map((item) => item.messageId))).toBe(0);

    const completed = await store.updateMission('w1', mission.id, { status: 'completed' });
    expect(completed.status).toBe('completed');
  });

  it('counts broadcasts as unread for the completing worker', async () => {
    const mission = await seedOwnedMission();
    await store.send('tower', { to: 'all', subject: 'policy update', body: 'new rule' });

    await expect(store.updateMission('w1', mission.id, { status: 'completed' })).rejects.toThrow(
      /1 unread inbox message\(s\) for w1/,
    );
  });

  it('tracks broadcast acknowledgements independently for each recipient', async () => {
    await seedOwnedMission();
    await store.registerAgent(
      rosterEntry({ name: 'w2', kind: 'worker', spawnedAt: '2026-09-20T00:00:00.000Z' }),
    );
    await store.send('tower', { to: 'all', subject: 'policy update', body: 'new rule' });

    const [message] = await store.readUnreadInbox('w1', 20);
    expect(message?.subject).toBe('policy update');
    expect(await store.ackInbox('w1', [message!.messageId])).toBe(0);

    expect(await store.readUnreadInbox('w1', 20)).toHaveLength(0);
    expect((await store.readUnreadInbox('w2', 20)).map((item) => item.subject)).toEqual([
      'policy update',
    ]);
    expect((await store.readUnreadInbox('tower', 20)).map((item) => item.subject)).toEqual([
      'policy update',
    ]);
    const state = await store.load();
    expect(state.roster.agents.find((agent) => agent.name === 'w1')?.inboxAckIds).toEqual([
      message!.messageId,
    ]);
    expect(state.roster.agents.find((agent) => agent.name === 'w2')?.inboxAckIds).toBeUndefined();
    expect(state.inboxAckIds).toBeUndefined();
  });

  it('does not block on messages that predate the worker registration', async () => {
    await store.send('tower', { to: 'all', subject: 'old broadcast', body: 'before spawn' });
    const mission = await seedOwnedMission(new Date().toISOString());

    const completed = await store.updateMission('w1', mission.id, { status: 'completed' });
    expect(completed.status).toBe('completed');
  });

  it('uses stable fallback IDs for legacy files without resurrecting cutoff history', async () => {
    await store.registerAgent(
      rosterEntry({
        name: 'w1',
        kind: 'worker',
        spawnedAt: '2026-09-20T00:00:00.000Z',
        lastInboxReadAt: '2026-09-21T00:00:00.000Z',
      }),
    );
    const oldRel = join('.tower/comms/inbox', 'legacy-old.md');
    const newRel = join('.tower/comms/inbox', 'legacy-new.md');
    await writeFile(
      store.abs(oldRel),
      '---\ntype: inbox\nfrom: tower\nto: w1\nsubject: already cutoff\nsent_at: 2026-09-20T12:00:00.000Z\n---\n\nold\n',
    );
    await writeFile(
      store.abs(newRel),
      '---\ntype: inbox\nfrom: tower\nto: w1\nsubject: after cutoff\nsent_at: 2026-09-22T00:00:00.000Z\n---\n\nnew\n',
    );

    const history = await store.readInbox('w1', 20);
    expect(history.find((item) => item.file === oldRel)?.messageId).toBe(oldRel);
    expect(history.find((item) => item.file === newRel)?.messageId).toBe(newRel);
    const unread = await store.readUnreadInbox('w1', 20);
    expect(unread.map((item) => item.subject)).toEqual(['after cutoff']);
    expect(await store.ackInbox('w1', unread.map((item) => item.messageId))).toBe(0);
    expect(await store.readUnreadInbox('w1', 20)).toHaveLength(0);

    const state = await store.load();
    expect(state.version).toBe(1);
    expect(state.roster.agents[0]?.lastInboxReadAt).toBe('2026-09-21T00:00:00.000Z');
    expect(state.roster.agents[0]?.inboxAckIds).toEqual([newRel]);
  });

  it('does not gate the tower completing a mission with unread worker messages', async () => {
    const mission = await seedOwnedMission();
    await store.send('tower', { to: 'w1', subject: 'requirement change', body: 'add a poem' });

    const completed = await store.updateMission('tower', mission.id, { status: 'completed' });
    expect(completed.status).toBe('completed');
  });
});

describe('findings', () => {
  beforeEach(async () => {
    await store.init();
    await store.registerAgent(rosterEntry({ name: 'w1', kind: 'worker' }));
  });

  it('rejects invalid finding types', async () => {
    await expect(
      store.fileFinding('w1', {
        type: 'nonsense' as TowerFindingType,
        title: 'x',
        summary: 's',
        details: 'd',
        suggestedFix: 'f',
      }),
    ).rejects.toThrow(TowerProtocolError);
  });

  it('writes the finding file under comms/findings', async () => {
    const rel = await store.fileFinding('w1', {
      type: 'bug',
      title: 'leaky cache',
      severity: 'high',
      summary: 'the cache never invalidates',
      location: 'src/cache.ts',
      details: 'no eviction path exists',
      suggestedFix: 'add a ttl',
    });
    expect(rel).toMatch(/^\.tower[/\\]comms[/\\]findings[/\\]/);
    const text = await readFile(join(repo, rel), 'utf8');
    expect(text).toContain('# Finding: leaky cache');
    expect(text).toContain('**Agent**: w1');
    expect(text).toContain('**Type**: bug');
    expect(text).toContain('**Severity**: high');
  });

  it('stamps the reporter token count into the finding and defaults to -1', async () => {
    const rel = await store.fileFinding('w1', {
      type: 'bug',
      title: 'leaky cache',
      summary: 'the cache never invalidates',
      details: 'no eviction path exists',
      suggestedFix: 'add a ttl',
      tokens: 4321,
    });
    const withTokens = await readFile(join(repo, rel), 'utf8');
    expect(withTokens).toContain('**Tokens**: 4321');

    const relDefault = await store.fileFinding('w1', {
      type: 'improve',
      title: 'second finding',
      summary: 's',
      details: 'd',
      suggestedFix: 'f',
    });
    const withoutTokens = await readFile(join(repo, relDefault), 'utf8');
    expect(withoutTokens).toContain('**Tokens**: -1');
  });
});

describe('merge gate', () => {
  beforeEach(async () => {
    await store.init();
  });

  it('walks the full gate: no review → p2 → clean → tip moved → clean re-review → merged', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'export const x = 1;\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );

    await expect(store.merge(mission.branch)).rejects.toThrow(/no review/);

    await store.submitReview('rev', {
      target: mission.branch,
      status: 'p2-1items',
      merge: 'fix-then-merge',
      findings: 'one nit to fix',
      decision: 'fix first',
    });
    await store.updateMission('tower', mission.id, { status: 'completed' }, { silent: true });
    await expect(store.merge(mission.branch)).rejects.toThrow(/clean round is required/);

    await cleanReview('rev', mission.branch);
    const reviewed = await store.latestReview(mission.branch);
    expect(reviewed?.round).toBe(2);
    expect(reviewed?.reviewedCommit).toBe(await git(repo, 'rev-parse', mission.branch));

    await commitFile(worktreeOf(mission), 'src/x/more.ts', 'export const more = 2;\n', 'more work');
    await expect(store.merge(mission.branch)).rejects.toThrow(/moved since the clean review/);

    await cleanReview('rev', mission.branch);
    const reReviewed = await store.latestReview(mission.branch);
    expect(reReviewed?.round).toBe(3);
    expect(reReviewed?.reviewedCommit).toBe(await git(repo, 'rev-parse', mission.branch));

    const { mergeCommit } = await store.merge(mission.branch);
    expect(mergeCommit).toBe(await git(repo, 'rev-parse', 'HEAD'));
    const state = await store.load();
    expect(state.missions.find((m) => m.id === mission.id)?.status).toBe('merged');
    const index = await readFile(join(repo, '.tower/comms/MISSIONS.md'), 'utf8');
    expect(index).toContain('✅');
  });

  it('refuses to merge when the main checkout has moved off the recorded base', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await cleanReview('rev', mission.branch);

    await git(repo, 'checkout', '-b', 'hotfix');
    const hotfixTip = await git(repo, 'rev-parse', 'HEAD');

    await expect(store.merge(mission.branch)).rejects.toThrow(/not the recorded base/);

    const state = await store.load();
    expect(state.missions.find((m) => m.id === mission.id)?.status).not.toBe('merged');
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(hotfixTip);
    const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(log).toContain('merge.blocked');
    expect(log).toContain('base-mismatch');

    await git(repo, 'checkout', 'main');
    const { mergeCommit } = await store.merge(mission.branch);
    expect(mergeCommit).toBe(await git(repo, 'rev-parse', 'HEAD'));
    expect((await store.load()).missions.find((m) => m.id === mission.id)?.status).toBe('merged');
  });

  it('refuses to merge from a detached HEAD', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await cleanReview('rev', mission.branch);

    await git(repo, 'checkout', '--detach', 'HEAD');
    await expect(store.merge(mission.branch)).rejects.toThrow(/detached HEAD/);
    expect((await store.load()).missions.find((m) => m.id === mission.id)?.status).not.toBe(
      'merged',
    );
  });

  it('only lets the assigned reviewer submit a review for the target', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await store.registerAgent(
      rosterEntry({ name: 'w1', kind: 'worker', missionId: mission.id }),
    );

    const input = {
      target: mission.branch,
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'ok',
    };
    await expect(store.submitReview('w1', input)).rejects.toThrow(/not an assigned reviewer/);
    await expect(store.submitReview('ghost', input)).rejects.toThrow(/not an assigned reviewer/);
    await expect(store.submitReview('rev', { ...input, target: 'feat/other' })).rejects.toThrow(
      /not an assigned reviewer/,
    );
  });

  it('stamps the reviewer token count into the review frontmatter and defaults to -1', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );

    await store.submitReview('rev', {
      target: mission.branch,
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'ok',
      tokens: 777,
    });
    const withTokens = await store.latestReview(mission.branch);
    expect(
      parseFrontmatter(await readFile(join(repo, withTokens!.file), 'utf8')).fields['tokens'],
    ).toBe('777');

    await store.submitReview('rev', {
      target: mission.branch,
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'ok again',
    });
    const withoutTokens = await store.latestReview(mission.branch);
    expect(
      parseFrontmatter(await readFile(join(repo, withoutTokens!.file), 'utf8')).fields['tokens'],
    ).toBe('-1');
  });

  it('refuses to merge while dependency missions are unmerged', async () => {
    const base = await setupMission({
      title: 'base lib',
      scope: 'src/lib/**',
      file: 'src/lib/a.ts',
      content: 'a\n',
    });
    const consumer = await setupMission({
      title: 'consumer app',
      scope: 'src/app/**',
      file: 'src/app/b.ts',
      content: 'b\n',
      deps: [base.id],
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev-base', kind: 'reviewer', reviewTarget: base.branch }),
    );
    await store.registerAgent(
      rosterEntry({ name: 'rev-app', kind: 'reviewer', reviewTarget: consumer.branch }),
    );
    await cleanReview('rev-app', consumer.branch);
    await expect(store.merge(consumer.branch)).rejects.toThrow(
      new RegExp(`dependencies not merged yet \\(${base.id}\\)`),
    );

    await cleanReview('rev-base', base.branch);
    await store.merge(base.branch);
    await expect(store.merge(consumer.branch)).rejects.toThrow(/behind base "main"/);
    const rebased = await store.rebaseMission('tower', consumer.id);
    expect(rebased.status).toBe('rebased');
    await store.merge(consumer.branch);
    const state = await store.load();
    expect(state.missions.find((m) => m.id === consumer.id)?.status).toBe('merged');
  });

  it('refuses files outside the mission scope until the tower widens it', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/outside.ts',
      content: 'export const o = 1;\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await store.registerAgent(
      rosterEntry({ name: 'w1', kind: 'worker', missionId: mission.id }),
    );
    await cleanReview('rev', mission.branch);

    await expect(
      store.merge(mission.branch, { activeAgentIds: new Set() }),
    ).rejects.toThrow(/outside mission M1 scope/);

    await store.plan([{ title: 'other', scope: ['src/other/**'] }]);
    await expect(
      store.updateMission('w1', mission.id, { scope: ['src/x/**', 'src/outside.ts'] }),
    ).rejects.toThrow(/cannot change mission scope/);

    const widened = await store.updateMission('tower', mission.id, {
      scope: ['src/x/**', 'src/other/**'],
    });
    expect(widened.deps).toEqual(['M2']);
    expect(widened.notes.join('\n')).toContain('auto dependency on M2');

    await store.updateMission('tower', 'M2', { status: 'abandoned' });
    await store.updateMission('tower', mission.id, { scope: ['src/x/**', 'src/outside.ts'] });
    const log = (await store.recentLog(5)).join('\n');
    expect(log).toContain('mission.update');
    expect(log).toContain('scope=src/x/**,src/outside.ts');
    await store.merge(mission.branch, { activeAgentIds: new Set() });
  });

  it('merge reports unmerged branches that changed the same files', async () => {
    const first = await setupMission({
      title: 'first touch',
      scope: 'src/a/**',
      file: 'src/a/shared.ts',
      content: 'from first\n',
    });
    const second = await setupMission({
      title: 'second touch',
      scope: 'src/b/**',
      file: 'src/b/b.ts',
      content: 'from second\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev-1', kind: 'reviewer', reviewTarget: first.branch }),
    );
    await store.registerAgent(
      rosterEntry({ name: 'rev-2', kind: 'reviewer', reviewTarget: second.branch }),
    );
    await cleanReview('rev-1', first.branch);
    await cleanReview('rev-2', second.branch);

    await commitFile(worktreeOf(second), 'src/a/shared.ts', 'tampered\n', 'stray edit');
    await cleanReview('rev-2', second.branch);
    await expect(store.merge(second.branch)).rejects.toThrow(/outside mission M2 scope/);

    const { conflictsWith } = await store.merge(first.branch);
    expect(conflictsWith).toEqual([
      { branch: second.branch, files: ['src/a/shared.ts'] },
    ]);
  });

  it('closes a zero-diff survey with a noop merge — no review, no git ceremony', async () => {
    const [mission] = await store.plan([
      { title: 'scan everything', scope: ['src/**'], kind: 'survey' },
    ]);
    const state = await store.load();
    await store.addWorktree(mission!.worktree, mission!.branch, state.base);

    const baseTip = await git(repo, 'rev-parse', 'HEAD');
    await completeMission(mission!);
    const result = await store.merge(mission!.branch);
    expect(result.noop).toBe(true);
    expect(result.mergeCommit).toBe(baseTip);
    expect((await store.load()).missions[0]?.status).toBe('merged');
    expect((await store.recentLog(3)).join('\n')).toContain('merge.noop');
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(baseTip);
  });

  it('enforces a zero-diff survey mission\'s own open dependencies', async () => {
    const [, survey] = await store.plan([
      { title: 'build dependency', scope: ['src/a/**'] },
      { title: 'survey dependent', scope: ['src/a/**'], kind: 'survey', deps: ['M1'] },
    ]);
    const state = await store.load();
    await store.addWorktree(survey!.worktree, survey!.branch, state.base);
    await completeMission(survey!);

    await expect(store.merge(survey!.branch)).rejects.toThrow(
      /dependencies not merged yet \(M1\)/,
    );
    expect((await store.load()).missions.find((mission) => mission.id === survey!.id)?.status).toBe('completed');

    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    await store.merge(survey!.branch);
    expect((await store.load()).missions.find((mission) => mission.id === survey!.id)?.status).toBe('merged');
  });

  it('refuses to merge a survey branch that has changes', async () => {
    const [mission] = await store.plan([
      { title: 'scan layer', scope: ['src/layer/**'], kind: 'survey' },
    ]);
    const state = await store.load();
    await store.addWorktree(mission!.worktree, mission!.branch, state.base);
    await commitFile(worktreeOf(mission!), 'src/layer/notes.ts', 'oops\n', 'stray edit');
    const completed = await store.load();
    completed.missions[0]!.status = 'completed';
    await writeFile(store.abs(STATE_FILE), `${JSON.stringify(completed, null, 2)}\n`);

    await expect(store.merge(mission!.branch)).rejects.toThrow(/read-only/);
    expect((await store.load()).missions[0]?.status).not.toBe('merged');
  });

  it('a build mission can depend on a survey and merges after its noop close', async () => {
    const [survey] = await store.plan([
      { title: 'scan x', scope: ['src/x/**'], kind: 'survey' },
    ]);
    const build = await setupMission({
      title: 'implement y',
      scope: 'src/y/**',
      file: 'src/y/y.ts',
      content: 'y\n',
      deps: [survey!.id],
    });
    const state = await store.load();
    await store.addWorktree(survey!.worktree, survey!.branch, state.base);
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: build.branch }),
    );
    await cleanReview('rev', build.branch);

    await expect(store.merge(build.branch)).rejects.toThrow(/dependencies not merged yet/);
    await completeMission(survey!);
    await store.merge(survey!.branch);
    await store.merge(build.branch);
    expect((await store.load()).missions.find((m) => m.id === build.id)?.status).toBe('merged');
  });

  it('treats an abandoned dependency as satisfied', async () => {
    const [, followUp] = await store.plan([
      { title: 'base work', scope: ['src/a/**'] },
      { title: 'follow up', scope: ['src/b/**'], deps: ['M1'] },
    ]);
    const state = await store.load();
    await store.addWorktree(followUp!.worktree, followUp!.branch, state.base);
    await commitFile(worktreeOf(followUp!), 'src/b/b.ts', 'b\n', 'work on M2');
    await completeMission(followUp!);
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: followUp!.branch }),
    );

    await expect(store.merge(followUp!.branch)).rejects.toThrow(/dependencies not merged yet/);

    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    await cleanReview('rev', followUp!.branch);
    await store.merge(followUp!.branch);
    expect((await store.load()).missions.find((m) => m.id === 'M2')?.status).toBe('merged');
  });

  it('excludes abandoned branches from the post-merge conflict report', async () => {
    const [first, second] = await store.plan([
      { title: 'first', scope: ['src/a/**'] },
      { title: 'second', scope: ['src/b/**'] },
    ]);
    const state = await store.load();
    await store.addWorktree(first!.worktree, first!.branch, state.base);
    await store.addWorktree(second!.worktree, second!.branch, state.base);
    await commitFile(worktreeOf(first!), 'src/a/shared.ts', 'from first\n', 'first');
    await commitFile(worktreeOf(second!), 'src/a/shared.ts', 'from second\n', 'second strays');
    await completeMission(first!);
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: first!.branch }),
    );
    await cleanReview('rev', first!.branch);

    const before = await store.merge(first!.branch);
    expect(before.conflictsWith.map((c) => c.branch)).toContain(second!.branch);

    await store.updateMission('tower', 'M2', { status: 'abandoned' });
    const [third] = await store.plan([{ title: 'third', scope: ['src/a/**'] }]);
    await store.addWorktree(third!.worktree, third!.branch, state.base);
    await commitFile(worktreeOf(third!), 'src/a/shared.ts', 'from third\n', 'third');
    await completeMission(third!);
    await store.registerAgent(
      rosterEntry({ name: 'rev3', kind: 'reviewer', reviewTarget: third!.branch }),
    );
    await cleanReview('rev3', third!.branch);

    const after = await store.merge(third!.branch);
    expect(after.conflictsWith.map((c) => c.branch)).not.toContain(second!.branch);
  });

  it('flips the live mission when an abandoned mission shares its branch — never the abandoned record', async () => {
    const [stale] = await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    await store.updateMission('tower', stale!.id, { status: 'abandoned' });
    const live: TowerMission = {
      ...stale!,
      id: 'M2',
      worktree: 'wt-2',
      status: 'completed',
      tasks: [],
      notes: [],
      blockers: [],
    };
    await spliceMissionIntoState(live);
    const state = await store.load();
    await store.addWorktree(live.worktree, live.branch, state.base);
    await commitFile(worktreeOf(live), 'src/x/x.ts', 'x\n', 'work on M2');
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: live.branch, reviewMissionId: 'M2' }),
    );
    await cleanReview('rev', live.branch);

    await store.merge(live.branch);

    const after = await store.load();
    expect(after.missions.find((m) => m.id === live.id)?.status).toBe('merged');
    expect(after.missions.find((m) => m.id === stale!.id)?.status).toBe('abandoned');
  });

  it('stamps the resolved mission on tower-submitted reviews', async () => {
    const [mission] = await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    const state = await store.load();
    await store.addWorktree(mission!.worktree, mission!.branch, state.base);
    await commitFile(worktreeOf(mission!), 'src/x/x.ts', 'x\n', 'work on M1');

    await cleanReview('tower', mission!.branch);

    expect((await store.latestReview(mission!.branch))?.mission).toBe(mission!.id);
  });

  it('stamps the mission recorded on the reviewer roster entry, not the mission resolved at submit time', async () => {
    const [first] = await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    const state = await store.load();
    await store.addWorktree(first!.worktree, first!.branch, state.base);
    await commitFile(worktreeOf(first!), 'src/x/x.ts', 'x\n', 'work on M1');
    await completeMission(first!);
    const second: TowerMission = {
      ...first!,
      id: 'M2',
      worktree: 'wt-2',
      status: 'active',
      tasks: [],
      notes: [],
      blockers: [],
    };
    await spliceMissionIntoState(second);
    await store.registerAgent(
      rosterEntry({
        name: 'rev',
        kind: 'reviewer',
        reviewTarget: first!.branch,
        reviewMissionId: 'M2',
      }),
    );
    await store.updateMission('tower', second.id, { status: 'abandoned' });

    await cleanReview('rev', first!.branch);

    expect((await store.latestReview(first!.branch))?.mission).toBe('M2');
    await expect(store.merge(first!.branch)).rejects.toThrow(/no review/);
    expect((await store.load()).missions.find((m) => m.id === first!.id)?.status).not.toBe(
      'merged',
    );
  });

  it('refuses to merge on an unstamped legacy review when another mission shares the branch', async () => {
    const [stale] = await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    const state = await store.load();
    await store.addWorktree(stale!.worktree, stale!.branch, state.base);
    await commitFile(worktreeOf(stale!), 'src/x/x.ts', 'x\n', 'work on M1');
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: stale!.branch }),
    );
    await store.updateMission('tower', stale!.id, { status: 'abandoned' });
    await cleanReview('rev', stale!.branch);
    expect((await store.latestReview(stale!.branch))?.mission).toBeUndefined();

    const live: TowerMission = {
      ...stale!,
      id: 'M2',
      worktree: 'wt-2',
      status: 'completed',
      tasks: [],
      notes: [],
      blockers: [],
    };
    await spliceMissionIntoState(live);

    await expect(store.merge(stale!.branch)).rejects.toThrow(/predates mission-stamped reviews/);
    const after = await store.load();
    expect(after.missions.find((m) => m.id === live.id)?.status).toBe('completed');
  });

  it('leaves reviews by unpinned legacy reviewers unstamped and still merges an unshared branch', async () => {
    const [mission] = await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    const state = await store.load();
    await store.addWorktree(mission!.worktree, mission!.branch, state.base);
    await commitFile(worktreeOf(mission!), 'src/x/x.ts', 'x\n', 'work on M1');
    await completeMission(mission!);
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission!.branch }),
    );

    await cleanReview('rev', mission!.branch);

    expect((await store.latestReview(mission!.branch))?.mission).toBeUndefined();
    await store.merge(mission!.branch);
    expect((await store.load()).missions.find((m) => m.id === mission!.id)?.status).toBe('merged');
  });

  it('refuses to merge on an unpinned legacy reviewer review when another mission shares the branch', async () => {
    const [stale] = await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    const state = await store.load();
    await store.addWorktree(stale!.worktree, stale!.branch, state.base);
    await commitFile(worktreeOf(stale!), 'src/x/x.ts', 'x\n', 'work on M1');
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: stale!.branch }),
    );
    const live: TowerMission = {
      ...stale!,
      id: 'M2',
      worktree: 'wt-2',
      status: 'completed',
      tasks: [],
      notes: [],
      blockers: [],
    };
    await spliceMissionIntoState(live);

    await cleanReview('rev', stale!.branch);

    expect((await store.latestReview(stale!.branch))?.mission).toBeUndefined();
    await expect(store.merge(stale!.branch)).rejects.toThrow(/predates mission-stamped reviews/);
    expect((await store.load()).missions.find((m) => m.id === live.id)?.status).toBe('completed');
  });

  it('refuses to merge when the only review was stamped for a different mission', async () => {
    const [stale] = await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    const state = await store.load();
    await store.addWorktree(stale!.worktree, stale!.branch, state.base);
    await commitFile(worktreeOf(stale!), 'src/x/x.ts', 'x\n', 'work on M1');
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: stale!.branch, reviewMissionId: 'M1' }),
    );
    await cleanReview('rev', stale!.branch);
    expect((await store.latestReview(stale!.branch))?.mission).toBe('M1');

    await store.updateMission('tower', stale!.id, { status: 'abandoned' });
    const live: TowerMission = {
      ...stale!,
      id: 'M2',
      worktree: 'wt-2',
      status: 'completed',
      tasks: [],
      notes: [],
      blockers: [],
    };
    await spliceMissionIntoState(live);

    await expect(store.merge(stale!.branch)).rejects.toThrow(/no review/);
    const after = await store.load();
    expect(after.missions.find((m) => m.id === live.id)?.status).toBe('completed');
  });

  it('selects the review stamped for the mission being merged over higher-round reviews stamped for a closed sibling', async () => {
    const [stale] = await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    const state = await store.load();
    await store.addWorktree(stale!.worktree, stale!.branch, state.base);
    await commitFile(worktreeOf(stale!), 'src/x/x.ts', 'x\n', 'work on M1');
    await store.registerAgent(
      rosterEntry({ name: 'rev-old', kind: 'reviewer', reviewTarget: stale!.branch, reviewMissionId: 'M1' }),
    );
    for (let round = 0; round < 5; round++) await cleanReview('rev-old', stale!.branch);

    await store.updateMission('tower', stale!.id, { status: 'abandoned' });
    const live: TowerMission = {
      ...stale!,
      id: 'M2',
      worktree: 'wt-2',
      status: 'completed',
      tasks: [],
      notes: [],
      blockers: [],
    };
    await spliceMissionIntoState(live);
    await store.registerAgent(
      rosterEntry({ name: 'rev-new', kind: 'reviewer', reviewTarget: stale!.branch, reviewMissionId: 'M2' }),
    );
    await cleanReview('rev-new', stale!.branch);

    await store.merge(stale!.branch);

    const after = await store.load();
    expect(after.missions.find((m) => m.id === live.id)?.status).toBe('merged');
    expect(after.missions.find((m) => m.id === stale!.id)?.status).toBe('abandoned');
  });

  it('prefers a mission-stamped clean review over a higher-round unstamped legacy review', async () => {
    const [stale] = await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    const state = await store.load();
    await store.addWorktree(stale!.worktree, stale!.branch, state.base);
    await commitFile(worktreeOf(stale!), 'src/x/x.ts', 'x\n', 'work on M1');
    await store.registerAgent(
      rosterEntry({ name: 'rev-old', kind: 'reviewer', reviewTarget: stale!.branch }),
    );
    for (let round = 0; round < 3; round++) await cleanReview('rev-old', stale!.branch);
    expect((await store.latestReview(stale!.branch))?.mission).toBeUndefined();

    await store.updateMission('tower', stale!.id, { status: 'abandoned' });
    const live: TowerMission = {
      ...stale!,
      id: 'M2',
      worktree: 'wt-2',
      status: 'completed',
      tasks: [],
      notes: [],
      blockers: [],
    };
    await spliceMissionIntoState(live);
    await store.registerAgent(
      rosterEntry({ name: 'rev-new', kind: 'reviewer', reviewTarget: stale!.branch, reviewMissionId: 'M2' }),
    );
    await cleanReview('rev-new', stale!.branch);

    await store.merge(stale!.branch);

    expect((await store.load()).missions.find((m) => m.id === live.id)?.status).toBe('merged');
  });

  it('blocks on a later unstamped legacy verdict on an unshared branch even after a stamped clean review', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev-new', kind: 'reviewer', reviewTarget: mission.branch, reviewMissionId: mission.id }),
    );
    await store.registerAgent(
      rosterEntry({ name: 'rev-old', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await cleanReview('rev-new', mission.branch);
    await store.submitReview('rev-old', {
      target: mission.branch,
      status: 'p1-1items',
      merge: 'hold',
      findings: 'a real problem',
      decision: 'do not merge',
    });
    await completeMission(mission);

    await expect(store.merge(mission.branch)).rejects.toThrow(/says hold/);
    expect((await store.load()).missions.find((m) => m.id === mission.id)?.status).not.toBe(
      'merged',
    );
  });

  it('merges an unshared branch when a stamped clean review is the latest verdict after a legacy p1', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev-new', kind: 'reviewer', reviewTarget: mission.branch, reviewMissionId: mission.id }),
    );
    await store.registerAgent(
      rosterEntry({ name: 'rev-old', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await store.submitReview('rev-old', {
      target: mission.branch,
      status: 'p1-1items',
      merge: 'hold',
      findings: 'a real problem',
      decision: 'do not merge',
    });
    await cleanReview('rev-new', mission.branch);
    await completeMission(mission);

    await store.merge(mission.branch);

    expect((await store.load()).missions.find((m) => m.id === mission.id)?.status).toBe('merged');
  });

  it('orders reviews by their recorded sequence, not filesystem mtime', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev-z', kind: 'reviewer', reviewTarget: mission.branch, reviewMissionId: mission.id }),
    );
    await store.registerAgent(
      rosterEntry({ name: 'rev-a', kind: 'reviewer', reviewTarget: mission.branch, reviewMissionId: mission.id }),
    );
    await cleanReview('rev-z', mission.branch);
    await store.submitReview('rev-a', {
      target: mission.branch,
      status: 'p1-1items',
      merge: 'hold',
      findings: 'a real problem',
      decision: 'do not merge',
    });

    const files = await store.reviewsFor(mission.branch);
    const earlier = files.find((r) => r.reviewer === 'rev-z')!;
    const later = files.find((r) => r.reviewer === 'rev-a')!;
    const now = new Date();
    await utimes(store.abs(earlier.file), now, now);
    await utimes(store.abs(later.file), new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000));
    await completeMission(mission);

    await expect(store.merge(mission.branch)).rejects.toThrow(/says hold/);
  });

  it('stamps a monotonically increasing submission sequence on reviews', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await cleanReview('rev', mission.branch);
    await store.submitReview('rev', {
      target: mission.branch,
      status: 'p2-1items',
      merge: 'fix-then-merge',
      findings: 'one nit',
      decision: 'fix first',
    });

    const reviews = await store.reviewsFor(mission.branch);
    expect(reviews.map((r) => r.seq)).toEqual([1, 2]);
  });

  it('refuses to merge a branch owned only by closed missions and leaves their records untouched', async () => {
    const [stale] = await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    const state = await store.load();
    await store.addWorktree(stale!.worktree, stale!.branch, state.base);
    await commitFile(worktreeOf(stale!), 'src/x/x.ts', 'x\n', 'work on M1');
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: stale!.branch }),
    );
    await cleanReview('rev', stale!.branch);
    await store.updateMission('tower', stale!.id, { status: 'abandoned' });

    await expect(store.merge(stale!.branch)).rejects.toThrow(/closed mission/);

    const after = await store.load();
    expect(after.missions.find((m) => m.id === stale!.id)?.status).toBe('abandoned');
    const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(log).toContain('merge.blocked');
  });

  it('refuses a mission that is not completed even with a clean review', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
      status: 'active',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await cleanReview('rev', mission.branch);

    await expect(store.merge(mission.branch)).rejects.toThrow(/only a completed mission/);
  });

  it('refuses a completed mission that still has an open task', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await cleanReview('rev', mission.branch);
    const state = await store.load();
    state.missions.find((candidate) => candidate.id === mission.id)!.tasks.push({
      text: 'unfinished',
      done: false,
    });
    await writeFile(store.abs(STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);

    await expect(store.merge(mission.branch)).rejects.toThrow(/1 open task.*unfinished/);
  });

  it('refuses a completed mission that still has blockers', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await cleanReview('rev', mission.branch);
    const state = await store.load();
    state.missions.find((candidate) => candidate.id === mission.id)!.blockers.push('still blocked');
    await writeFile(store.abs(STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);

    await expect(store.merge(mission.branch)).rejects.toThrow(/1 blocker.*still blocked/);
  });

  it('fails closed for unknown worker runtime and refuses busy workers before accepting idle workers', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    const worker = rosterEntry({ name: 'w1', kind: 'worker', missionId: mission.id });
    await store.registerAgent(worker);
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await cleanReview('rev', mission.branch);

    await expect(store.merge(mission.branch)).rejects.toThrow(/unknown is not idle/);
    await expect(
      store.merge(mission.branch, { activeAgentIds: new Set([worker.agentId]) }),
    ).rejects.toThrow(/mid-turn/);
    await store.merge(mission.branch, { activeAgentIds: new Set() });

    expect((await store.load()).missions.find((candidate) => candidate.id === mission.id)?.status).toBe('merged');
  });

  it('requires the latest applicable review to be clean with merge approval', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await store.submitReview('rev', {
      target: mission.branch,
      status: 'clean',
      merge: 'hold',
      findings: 'none',
      decision: 'wait',
    });
    await expect(store.merge(mission.branch)).rejects.toThrow(/says hold/);

    await store.submitReview('rev', {
      target: mission.branch,
      status: 'clean',
      merge: 'fix-then-merge',
      findings: 'none',
      decision: 'fix first',
    });
    await expect(store.merge(mission.branch)).rejects.toThrow(/fix-then-merge is not approval/);

    await cleanReview('rev', mission.branch);
    await store.merge(mission.branch);
    expect((await store.load()).missions.find((candidate) => candidate.id === mission.id)?.status).toBe('merged');
  });

  it('keeps accepting a legacy clean review without a merge field', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await cleanReview('rev', mission.branch);
    const review = (await store.latestReview(mission.branch))!;
    const raw = await readFile(store.abs(review.file), 'utf8');
    await writeFile(store.abs(review.file), raw.replace(/^merge:.*\r?\n/m, ''));

    await store.merge(mission.branch);

    expect((await store.load()).missions.find((candidate) => candidate.id === mission.id)?.status).toBe('merged');
  });

  it('merges only the evaluated SHA and reports an advanced branch without marking the mission merged', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await cleanReview('rev', mission.branch);
    const evaluated = await git(repo, 'rev-parse', mission.branch);
    const worktree = worktreeOf(mission);
    await writeFile(
      join(repo, '.git/hooks/post-merge'),
      [
        '#!/bin/sh',
        'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE',
        `printf 'export const later = 2;\\n' > "${worktree}/src/x/later.ts"`,
        `git -C "${worktree}" add src/x/later.ts`,
        `git -C "${worktree}" commit -m 'worker advances during merge'`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const result = await store.merge(mission.branch);
    const advanced = await git(repo, 'rev-parse', mission.branch);

    expect(result.status).toBe('advanced');
    expect(result.evaluatedBranchTip).toBe(evaluated);
    expect(result.currentBranchTip).toBe(advanced);
    expect(advanced).not.toBe(evaluated);
    expect(await git(repo, 'rev-parse', 'HEAD^2')).toBe(evaluated);
    expect(await git(repo, 'log', '-1', '--format=%s')).toBe(`Merge branch '${mission.branch}'`);
    await expect(git(repo, 'merge-base', '--is-ancestor', advanced, 'HEAD')).rejects.toThrow();
    expect((await store.load()).missions.find((candidate) => candidate.id === mission.id)?.status).toBe('completed');
    expect((await store.recentLog(3)).join('\n')).toContain('merge.advanced');
  });
});

describe('rebaseMission', () => {
  beforeEach(async () => {
    await store.init();
  });

  it('refuses non-tower callers', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await expect(store.rebaseMission('w1', mission.id)).rejects.toThrow(/only the tower/);
  });

  it('reports up-to-date when the branch already contains the base tip', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    const result = await store.rebaseMission('tower', mission.id);
    expect(result.status).toBe('up-to-date');
  });

  it('rebases a stale branch cleanly and the merge gate waives the re-review', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await cleanReview('rev', mission.branch);
    await commitFile(repo, 'docs/readme.md', 'docs\n', 'base moves on');

    await expect(store.merge(mission.branch)).rejects.toThrow(/behind base "main"/);
    const result = await store.rebaseMission('tower', mission.id);
    expect(result.status).toBe('rebased');

    await store.merge(mission.branch);
    expect((await store.load()).missions.find((m) => m.id === mission.id)?.status).toBe('merged');
    const log = (await store.recentLog(10)).join('\n');
    expect(log).toContain('rebase.mission');
    expect(log).toContain('review_waived=yes');
  });

  it('a worker commit after the tower rebase voids the review waiver', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await cleanReview('rev', mission.branch);
    await commitFile(repo, 'docs/readme.md', 'docs\n', 'base moves on');
    await store.rebaseMission('tower', mission.id);

    await commitFile(worktreeOf(mission), 'src/x/x.ts', 'x2\n', 'worker adds more');
    await expect(store.merge(mission.branch)).rejects.toThrow(/moved since the clean review/);
  });

  it('aborts a conflicting rebase, marks the mission blocked, and reports the conflicted files', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/shared.ts',
      content: 'from branch\n',
    });
    const tipBefore = await git(repo, 'rev-parse', mission.branch);
    await commitFile(repo, 'src/x/shared.ts', 'from base\n', 'base touches the same file');

    const result = await store.rebaseMission('tower', mission.id);
    expect(result.status).toBe('conflict');
    expect(result.files).toEqual(['src/x/shared.ts']);

    const after = (await store.load()).missions.find((m) => m.id === mission.id)!;
    expect(after.status).toBe('blocked');
    expect(after.blockers.join('\n')).toContain('src/x/shared.ts');
    expect(await git(worktreeOf(mission), 'status', '--porcelain')).toBe('');
    expect(await git(repo, 'rev-parse', mission.branch)).toBe(tipBefore);
  });

  it('refuses while the worktree has uncommitted changes', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await commitFile(repo, 'docs/readme.md', 'docs\n', 'base moves on');
    await writeFile(join(worktreeOf(mission), 'src/x/x.ts'), 'dirty\n');

    await expect(store.rebaseMission('tower', mission.id)).rejects.toThrow(
      /uncommitted changes/,
    );
  });

  it('requires authoritative idle runtime for every mission worker', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    const worker = rosterEntry({ name: 'w1', kind: 'worker', missionId: mission.id });
    await store.registerAgent(worker);
    await commitFile(repo, 'docs/readme.md', 'docs\n', 'base moves on');

    await expect(store.rebaseMission('tower', mission.id)).rejects.toThrow(/unknown is not idle/);
    await expect(
      store.rebaseMission('tower', mission.id, { activeAgentIds: new Set([worker.agentId]) }),
    ).rejects.toThrow(/mid-turn/);
    const result = await store.rebaseMission('tower', mission.id, { activeAgentIds: new Set() });
    expect(result.status).toBe('rebased');
  });

  it('refuses a worktree whose current branch does not match the mission', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await git(worktreeOf(mission), 'checkout', '--detach', 'HEAD');

    await expect(store.rebaseMission('tower', mission.id)).rejects.toThrow(
      /not mission branch/,
    );
    expect((await store.load()).missions.find((candidate) => candidate.id === mission.id)?.lastRebase).toBeUndefined();
  });

  it('refuses a worktree whose HEAD differs from the mission branch tip', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    const worktree = worktreeOf(mission);
    await commitFile(worktree, 'src/x/more.ts', 'more\n', 'branch advances');
    const { stdout } = await execFileAsync('which', ['git']);
    const realGit = stdout.trim();
    const wrapperDir = await mkdtemp(join(tmpdir(), 'tower-git-head-wrapper-'));
    const previousPath = process.env['PATH'] ?? '';
    try {
      await writeFile(
        join(wrapperDir, 'git'),
        [
          '#!/bin/sh',
          'if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then',
          `  exec '${realGit}' rev-parse HEAD~1`,
          'fi',
          `exec '${realGit}' "$@"`,
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      process.env['PATH'] = `${wrapperDir}:${previousPath}`;

      await expect(store.rebaseMission('tower', mission.id)).rejects.toThrow(
        /does not match mission branch/,
      );
    } finally {
      process.env['PATH'] = previousPath;
      await rm(wrapperDir, { recursive: true, force: true });
    }
    expect((await store.load()).missions.find((candidate) => candidate.id === mission.id)?.lastRebase).toBeUndefined();
  });

  it('does not mark a mission blocked for a non-conflict rebase failure', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await commitFile(repo, 'docs/readme.md', 'docs\n', 'base moves on');
    await writeFile(join(repo, '.git/hooks/pre-rebase'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    await expect(store.rebaseMission('tower', mission.id)).rejects.toThrow(
      /no rebase conflict with unmerged paths/,
    );
    const after = (await store.load()).missions.find((candidate) => candidate.id === mission.id)!;
    expect(after.status).toBe('completed');
    expect(after.blockers).toEqual([]);
    expect(after.lastRebase).toBeUndefined();
  });

  it('reports recovery-required without claiming recovery when rebase abort fails', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/shared.ts',
      file: 'src/x/shared.ts',
      content: 'from branch\n',
    });
    await commitFile(repo, 'src/x/shared.ts', 'from base\n', 'base touches the same file');
    const { stdout } = await execFileAsync('which', ['git']);
    const realGit = stdout.trim();
    const wrapperDir = await mkdtemp(join(tmpdir(), 'tower-git-wrapper-'));
    const previousPath = process.env['PATH'] ?? '';
    try {
      await writeFile(
        join(wrapperDir, 'git'),
        [
          '#!/bin/sh',
          'if [ "$1" = "rebase" ] && [ "$2" = "--abort" ]; then',
          '  exit 97',
          'fi',
          `exec '${realGit}' "$@"`,
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      process.env['PATH'] = `${wrapperDir}:${previousPath}`;

      await expect(store.rebaseMission('tower', mission.id)).rejects.toThrow(/recovery-required/);
    } finally {
      process.env['PATH'] = previousPath;
      await rm(wrapperDir, { recursive: true, force: true });
    }

    const after = (await store.load()).missions.find((candidate) => candidate.id === mission.id)!;
    expect(after.status).toBe('completed');
    expect(after.blockers).toEqual([]);
    expect(after.lastRebase).toBeUndefined();
    await git(worktreeOf(mission), 'rebase', '--abort');
  });

  it('runs the whole rebase under the tower state lock', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    const locked = new TowerStore(repo, { stateLockTimeoutMs: 100, stateLockPollMs: 10 });
    const lockPath = `${store.abs(STATE_FILE)}.lock`;
    await writeFile(lockPath, 'pid=999999 since=2026-09-30T00:00:00.000Z token=other');
    try {
      await expect(locked.rebaseMission('tower', mission.id)).rejects.toThrow(
        /timed out.*tower state lock/,
      );
    } finally {
      await rm(lockPath, { force: true });
    }
    expect((await store.load()).missions.find((candidate) => candidate.id === mission.id)?.lastRebase).toBeUndefined();
  });

  it('mergeNoFf aborts and restores a non-conflicting merge rejected by a commit hook', async () => {
    await git(repo, 'checkout', '-b', 'hook-failure');
    await commitFile(repo, 'hook.txt', 'side\n', 'non-conflicting side change');
    await git(repo, 'checkout', 'main');
    const headBefore = await git(repo, 'rev-parse', 'HEAD');
    const statusBefore = await git(repo, 'status', '--porcelain');
    await writeFile(join(repo, '.git/hooks/commit-msg'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    await expect(mergeNoFf(repo, 'hook-failure')).rejects.toThrow();

    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(await git(repo, 'status', '--porcelain')).toBe(statusBefore);
    await expect(git(repo, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')).rejects.toThrow();
    await expect(stat(join(repo, 'hook.txt'))).rejects.toThrow();
  });

  it('mergeNoFf refuses to start over an existing merge and leaves it untouched', async () => {
    await git(repo, 'checkout', '-b', 'existing-merge');
    await commitFile(repo, 'existing.txt', 'side\n', 'existing merge work');
    await git(repo, 'checkout', 'main');
    await git(repo, 'merge', '--no-ff', '--no-commit', 'existing-merge');
    const mergeHead = await git(repo, 'rev-parse', 'MERGE_HEAD');
    const headBefore = await git(repo, 'rev-parse', 'HEAD');
    const statusBefore = await git(repo, 'status', '--porcelain');

    await expect(mergeNoFf(repo, 'existing-merge')).rejects.toThrow(/MERGE_HEAD already exists/);

    expect(await git(repo, 'rev-parse', 'MERGE_HEAD')).toBe(mergeHead);
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(await git(repo, 'status', '--porcelain')).toBe(statusBefore);
    await git(repo, 'merge', '--abort');
  });

  it('mergeNoFf aborts a conflicting merge and leaves the checkout clean', async () => {
    await git(repo, 'checkout', '-b', 'conflicting');
    await commitFile(repo, 'README.md', '# conflicting\n', 'conflict change');
    await git(repo, 'checkout', 'main');
    const mainTip = await git(repo, 'rev-parse', 'HEAD');
    await commitFile(repo, 'README.md', '# main change\n', 'main change');

    await expect(mergeNoFf(repo, 'conflicting')).rejects.toThrow();
    expect(await git(repo, 'status', '--porcelain')).toBe('');
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(await git(repo, 'rev-parse', 'main'));
    expect(mainTip).not.toBe(await git(repo, 'rev-parse', 'HEAD'));
  });

  it('propagates git query failures instead of reporting clean, missing, or not-ancestor', async () => {
    const missing = join(repo, 'missing-worktree');

    await expect(branchExists(missing, 'main')).rejects.toThrow();
    await expect(isAncestor(repo, 'missing-ref', 'HEAD')).rejects.toThrow();
    await expect(isWorktreeDirty(missing)).rejects.toThrow();
  });
});

describe('rework loop closure', () => {
  beforeEach(async () => {
    await store.init();
  });

  async function missionIn(
    status: 'planned' | 'active' | 'completed' | 'blocked' | 'paused',
    title = 'feature x',
  ) {
    const mission = await setupMission({
      title,
      scope: `src/${title.replaceAll(' ', '-')}/**`,
      file: `src/${title.replaceAll(' ', '-')}/x.ts`,
      content: 'x\n',
      status,
    });
    if (status === 'blocked') {
      await store.updateMission('tower', mission.id, { blocker: 'waiting on an answer' });
    } else if (status !== 'planned') {
      await store.updateMission('tower', mission.id, { status });
    }
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch, reviewMissionId: mission.id }),
    );
    return mission;
  }

  async function nonCleanReview(target: string): Promise<void> {
    await store.submitReview('rev', {
      target,
      status: 'p1-1items',
      merge: 'fix-then-merge',
      findings: 'one real problem',
      decision: 'send it back',
    });
  }

  it('flips a completed mission back to active for rework and lets it complete again', async () => {
    const mission = await missionIn('completed');

    await nonCleanReview(mission.branch);

    expect((await store.load()).missions.find((m) => m.id === mission.id)?.status).toBe('active');
    const review = await store.latestReview(mission.branch);
    expect(review?.mission).toBe(mission.id);
    expect(review?.status).toBe('p1-1items');
    const missionFile = await readFile(
      join(repo, '.tower/comms/missions', `${mission.id}-feature-x.md`),
      'utf8',
    );
    expect(missionFile).toContain('🔵');
    expect(missionFile).not.toContain('🟢');
    const index = await readFile(join(repo, '.tower/comms/MISSIONS.md'), 'utf8');
    expect(index).toContain('🔵');
    const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(log).toContain('mission.rework');
    expect((await store.updateMission('tower', mission.id, { status: 'completed' })).status).toBe(
      'completed',
    );
  });

  it('keeps a completed mission completed on a clean verdict', async () => {
    const mission = await missionIn('completed');

    await cleanReview('rev', mission.branch);

    expect((await store.load()).missions.find((m) => m.id === mission.id)?.status).toBe(
      'completed',
    );
  });

  it('never flips a merged mission', async () => {
    const mission = await missionIn('completed');
    await cleanReview('rev', mission.branch);
    await store.merge(mission.branch);
    expect((await store.load()).missions.find((m) => m.id === mission.id)?.status).toBe('merged');

    await nonCleanReview(mission.branch);

    expect((await store.load()).missions.find((m) => m.id === mission.id)?.status).toBe('merged');
  });

  it('leaves blocked and paused missions alone', async () => {
    const blocked = await missionIn('blocked');
    await nonCleanReview(blocked.branch);
    expect((await store.load()).missions.find((m) => m.id === blocked.id)?.status).toBe('blocked');

    const paused = await missionIn('paused', 'feature y');
    await store.registerAgent(
      rosterEntry({ name: 'rev-2', kind: 'reviewer', reviewTarget: paused.branch, reviewMissionId: paused.id }),
    );
    await store.submitReview('rev-2', {
      target: paused.branch,
      status: 'p2-2items',
      merge: 'fix-then-merge',
      findings: 'two nits',
      decision: 'send it back',
    });
    expect((await store.load()).missions.find((m) => m.id === paused.id)?.status).toBe('paused');
  });

  it('leaves active and planned missions alone', async () => {
    const active = await missionIn('active');
    await nonCleanReview(active.branch);
    expect((await store.load()).missions.find((m) => m.id === active.id)?.status).toBe('active');

    const planned = await setupMission({
      title: 'feature y',
      scope: 'src/y/**',
      file: 'src/y/y.ts',
      content: 'y\n',
      status: 'planned',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev-y', kind: 'reviewer', reviewTarget: planned.branch }),
    );
    await store.submitReview('rev-y', {
      target: planned.branch,
      status: 'p2-1items',
      merge: 'fix-then-merge',
      findings: 'one nit',
      decision: 'send it back',
    });
    expect((await store.load()).missions.find((m) => m.id === planned.id)?.status).toBe('planned');
  });

  it('flips a completed mission resolved by branch when the tower submits the verdict', async () => {
    const mission = await missionIn('completed');

    await store.submitReview('tower', {
      target: mission.branch,
      status: 'p1-1items',
      merge: 'hold',
      findings: 'a real problem',
      decision: 'do not merge',
    });

    expect((await store.load()).missions.find((m) => m.id === mission.id)?.status).toBe('active');
  });
});

describe('review notification recipients', () => {
  beforeEach(async () => {
    await store.init();
  });

  async function setupMissionForReview(options: { readonly withOwner?: boolean } = {}) {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    if (options.withOwner !== false) {
      await store.registerAgent(
        rosterEntry({ name: 'w1', kind: 'worker', missionId: mission.id }),
      );
      await store.updateMission('tower', mission.id, { owner: 'w1' }, { silent: true });
    }
    await store.registerAgent(
      rosterEntry({
        name: 'rev',
        kind: 'reviewer',
        reviewTarget: mission.branch,
        reviewMissionId: mission.id,
      }),
    );
    return mission;
  }

  it('notifies only the tower for a clean verdict and returns the structured review', async () => {
    const mission = await setupMissionForReview();

    const result = await store.submitReview('rev', {
      target: mission.branch,
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'ok',
    });

    expect(result.review).toMatchObject({ target: mission.branch, round: 1, mission: mission.id });
    expect(result.storedMessages.map((message) => message.item.to)).toEqual(['tower']);
    expect(result.notificationError).toBeUndefined();
  });

  it('notifies a valid open-mission owner and the tower with full review metadata', async () => {
    const mission = await setupMissionForReview();

    const result = await store.submitReview('rev', {
      target: mission.branch,
      status: 'p1-1items',
      merge: 'hold',
      findings: 'broken',
      decision: 'fix it',
    });

    expect(result.storedMessages.map((message) => message.item.to)).toEqual(['w1', 'tower']);
    const ownerMessage = result.storedMessages[0]!;
    expect(ownerMessage.item.subject).toBe('review-result');
    expect(ownerMessage.item.scope).toBe(mission.id);
    expect(ownerMessage.item.action).toBe('review-result');
    expect(ownerMessage.item.body).toContain(`file: ${result.review.file}`);
    expect(ownerMessage.item.body).toContain(`target: ${mission.branch}`);
    expect(ownerMessage.item.body).toContain(`mission: ${mission.id}`);
    expect(ownerMessage.item.body).toContain('round: 1');
    expect(ownerMessage.item.body).toContain('verdict: p1-1items');
    expect(ownerMessage.item.body).toContain('merge recommendation: hold');
    expect(ownerMessage.item.body).toContain(`reviewedCommit: ${result.review.reviewedCommit}`);
    expect(ownerMessage.item.body).toContain('owner: w1');
    expect((await store.load()).missions.find((candidate) => candidate.id === mission.id)?.status).toBe('active');
  });

  it('uses only the tower when there is no valid owner', async () => {
    const mission = await setupMissionForReview({ withOwner: false });

    const result = await store.submitReview('rev', {
      target: mission.branch,
      status: 'p2-1items',
      merge: 'fix-then-merge',
      findings: 'nit',
      decision: 'fix later',
    });

    expect(result.storedMessages.map((message) => message.item.to)).toEqual(['tower']);
  });

  it('does not wake the author or reopen a closed mission', async () => {
    const mission = await setupMissionForReview();
    await store.updateMission('tower', mission.id, { status: 'abandoned' });

    const result = await store.submitReview('rev', {
      target: mission.branch,
      status: 'p1-1items',
      merge: 'hold',
      findings: 'late problem',
      decision: 'late review',
    });

    expect(result.storedMessages.map((message) => message.item.to)).toEqual(['tower']);
    expect(result.storedMessages.some((message) => message.item.to === 'w1')).toBe(false);
    expect((await store.load()).missions.find((candidate) => candidate.id === mission.id)?.status).toBe('abandoned');
  });

  it('never sends a tower-originated review to the tower itself', async () => {
    const mission = await setupMissionForReview();

    const clean = await store.submitReview('tower', {
      target: mission.branch,
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'ok',
    });
    const nonClean = await store.submitReview('tower', {
      target: mission.branch,
      status: 'p1-1items',
      merge: 'hold',
      findings: 'problem',
      decision: 'fix it',
    });

    expect(clean.storedMessages).toEqual([]);
    expect(nonClean.storedMessages.map((message) => message.item.to)).toEqual(['w1']);
  });
});

describe('complete and review concurrency', () => {
  beforeEach(async () => {
    await store.init();
  });

  it('serializes complete and non-clean review without losing review-result', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
      status: 'active',
    });
    await store.registerAgent(
      rosterEntry({ name: 'w1', kind: 'worker', missionId: mission.id }),
    );
    await store.updateMission('tower', mission.id, { owner: 'w1' }, { silent: true });
    await store.registerAgent(
      rosterEntry({
        name: 'rev',
        kind: 'reviewer',
        reviewTarget: mission.branch,
        reviewMissionId: mission.id,
      }),
    );

    const [reviewOutcome, completeOutcome] = await Promise.allSettled([
      store.submitReview('rev', {
        target: mission.branch,
        status: 'p1-1items',
        merge: 'hold',
        findings: 'problem',
        decision: 'fix it',
      }),
      store.complete('w1', 'race report'),
    ]);

    expect(reviewOutcome.status).toBe('fulfilled');
    if (completeOutcome.status === 'rejected') {
      expect(String(completeOutcome.reason)).toContain('unread inbox message');
    }
    const state = await store.load();
    expect(state.missions.find((candidate) => candidate.id === mission.id)?.status).toBe('active');
    const messages = await store.readInbox('tower', 50);
    expect(messages.filter((item) => item.subject === 'review-result' && item.to === 'w1')).toHaveLength(1);
    expect(messages.filter((item) => item.subject === 'review-result' && item.to === 'tower')).toHaveLength(1);
  });
});

describe('dirty base checkout', () => {
  beforeEach(async () => {
    await store.init();
  });

  it('snapshots uncommitted base changes as the mission branch base without touching the checkout', async () => {
    await writeFile(join(repo, 'README.md'), '# fixture\nwip edit\n');
    await writeFile(join(repo, 'staged.ts'), 'export const staged = 1;\n');
    await git(repo, 'add', 'staged.ts');
    await writeFile(join(repo, 'untracked.ts'), 'export const untracked = 1;\n');
    const statusBefore = await git(repo, 'status', '--porcelain');
    const baseTip = await git(repo, 'rev-parse', 'main');

    const [mission] = await store.plan([{ title: 'wip consumer', scope: ['src/**'] }]);
    const state = await store.load();
    const added = await store.addWorktree(mission!.worktree, mission!.branch, state.base);

    expect(added.spawnBase).toBeDefined();
    const wt = worktreeOf(mission!);
    expect(await readFile(join(wt, 'README.md'), 'utf8')).toBe('# fixture\nwip edit\n');
    expect(await readFile(join(wt, 'staged.ts'), 'utf8')).toBe('export const staged = 1;\n');
    expect(await readFile(join(wt, 'untracked.ts'), 'utf8')).toBe('export const untracked = 1;\n');
    expect(await git(wt, 'status', '--porcelain')).toBe('');

    expect(await git(repo, 'rev-parse', `${added.spawnBase}^`)).toBe(baseTip);
    expect(await git(repo, 'rev-parse', mission!.branch)).toBe(added.spawnBase);

    expect(await git(repo, 'status', '--porcelain')).toBe(statusBefore);
    expect(await git(repo, 'rev-parse', 'main')).toBe(baseTip);
    expect((await store.load()).missions[0]?.spawnBase).toBeUndefined();

    const log = (await store.recentLog(3)).join('\n');
    expect(log).toContain('worktree.add');
    expect(log).toContain(`spawn_base=${added.spawnBase}`);
  });

  it('excludes .tower/ protocol files and gitignored paths from the snapshot', async () => {
    await commitFile(repo, '.gitignore', 'ignored/\n', 'ignore rules');
    await mkdir(join(repo, 'ignored'), { recursive: true });
    await writeFile(join(repo, 'ignored/blob.txt'), 'ignored\n');
    await writeFile(join(repo, 'wip.ts'), 'wip\n');

    const [mission] = await store.plan([{ title: 'wip consumer', scope: ['src/**'] }]);
    const state = await store.load();
    const added = await store.addWorktree(mission!.worktree, mission!.branch, state.base);

    expect(added.spawnBase).toBeDefined();
    const snapshotFiles = (await git(repo, 'diff', '--name-only', `${added.spawnBase}^`, added.spawnBase!)).split('\n');
    expect(snapshotFiles).toEqual(['wip.ts']);
    await expect(stat(join(worktreeOf(mission!), '.tower'))).rejects.toThrow();
    await expect(stat(join(worktreeOf(mission!), 'ignored'))).rejects.toThrow();
  });

  it('snapshots base WIP when the tower root is a repository subdirectory', async () => {
    const sub = join(repo, 'sub');
    await mkdir(sub, { recursive: true });
    const subStore = new TowerStore(sub);
    await subStore.init();
    await writeFile(join(sub, 'wip.ts'), 'export const wip = 1;\n');

    const [mission] = await subStore.plan([{ title: 'wip consumer', scope: ['src/**'] }]);
    const state = await subStore.load();
    const added = await subStore.addWorktree(mission!.worktree, mission!.branch, state.base);

    expect(added.spawnBase).toBeDefined();
    const snapshotFiles = (
      await git(repo, 'diff', '--name-only', `${added.spawnBase}^`, added.spawnBase!)
    ).split('\n');
    expect(snapshotFiles).toEqual(['sub/wip.ts']);
    const wt = join(sub, '.tower/worktrees', mission!.worktree);
    expect(await readFile(join(wt, 'sub/wip.ts'), 'utf8')).toBe('export const wip = 1;\n');
  });

  it('refuses to create a worktree while the base checkout has unmerged paths', async () => {
    await git(repo, 'checkout', '-b', 'side');
    await commitFile(repo, 'conflict.txt', 'side\n', 'side change');
    await git(repo, 'checkout', 'main');
    await commitFile(repo, 'conflict.txt', 'main\n', 'main change');
    await expect(git(repo, 'merge', 'side')).rejects.toThrow();

    const [mission] = await store.plan([{ title: 'wip consumer', scope: ['src/**'] }]);
    const state = await store.load();
    await expect(
      store.addWorktree(mission!.worktree, mission!.branch, state.base),
    ).rejects.toThrow(/unmerged paths/);

    await git(repo, 'merge', '--abort');
  });

  it('refuses to snapshot WIP from a checkout that is not the recorded base', async () => {
    await git(repo, 'checkout', '-b', 'side');
    await commitFile(repo, 'README.md', '# side\n', 'side version');
    await writeFile(join(repo, 'README.md'), '# side wip\n');

    const [mission] = await store.plan([{ title: 'wip consumer', scope: ['src/**'] }]);
    const state = await store.load();
    await expect(
      store.addWorktree(mission!.worktree, mission!.branch, state.base),
    ).rejects.toThrow(/on "side" with uncommitted changes, not the recorded base "main"/);
    await expect(stat(join(repo, '.tower/worktrees', mission!.worktree))).rejects.toThrow();
    await expect(git(repo, 'rev-parse', '--verify', mission!.branch)).rejects.toThrow();
  });

  it('refuses to snapshot WIP from a detached HEAD checkout', async () => {
    await writeFile(join(repo, 'wip.ts'), 'export const wip = 1;\n');
    await git(repo, 'checkout', '--detach', 'HEAD');

    const [mission] = await store.plan([{ title: 'wip consumer', scope: ['src/**'] }]);
    const state = await store.load();
    await expect(
      store.addWorktree(mission!.worktree, mission!.branch, state.base),
    ).rejects.toThrow(/detached HEAD state with uncommitted changes/);
  });

  it('the merge gate ignores snapshotted base WIP and blocks only while the checkout still holds it', async () => {
    await writeFile(join(repo, 'wip.ts'), 'export const wip = 1;\n');
    const [mission] = await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    const state = await store.load();
    const added = await store.addWorktree(mission!.worktree, mission!.branch, state.base);
    expect(added.spawnBase).toBeDefined();
    await store.updateMission('tower', mission!.id, { spawnBase: added.spawnBase });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission!.branch }),
    );
    await commitFile(worktreeOf(mission!), 'src/x/x.ts', 'export const x = 1;\n', 'work on M1');
    await completeMission(mission!);
    await cleanReview('rev', mission!.branch);

    await expect(store.merge(mission!.branch)).rejects.toThrow(
      /uncommitted changes in file\(s\) this merge would overwrite: wip\.ts/,
    );
    const log = (await store.recentLog(3)).join('\n');
    expect(log).toContain('merge.blocked');
    expect(log).toContain('reason=base-dirty');
    expect((await store.load()).missions[0]?.status).not.toBe('merged');

    await git(repo, 'add', 'wip.ts');
    await git(repo, 'commit', '-m', 'commit my wip');

    const rebased = await store.rebaseMission('tower', mission!.id);
    expect(rebased.status).toBe('rebased');
    const { mergeCommit } = await store.merge(mission!.branch);
    expect(mergeCommit).toBe(await git(repo, 'rev-parse', 'HEAD'));
    expect((await store.load()).missions[0]?.status).toBe('merged');
    expect(await readFile(join(repo, 'wip.ts'), 'utf8')).toBe('export const wip = 1;\n');
    expect(await readFile(join(repo, 'src/x/x.ts'), 'utf8')).toBe('export const x = 1;\n');
  });

  it('falls back to the base branch for the scope diff after a rebase drops the snapshot', async () => {
    await writeFile(join(repo, 'wip.ts'), 'export const wip = 1;\n');
    const [mission] = await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    const state = await store.load();
    const added = await store.addWorktree(mission!.worktree, mission!.branch, state.base);
    expect(added.spawnBase).toBeDefined();
    await store.updateMission('tower', mission!.id, { spawnBase: added.spawnBase });
    const wt = worktreeOf(mission!);
    await commitFile(wt, 'src/x/x.ts', 'export const x = 1;\n', 'work on M1');
    await completeMission(mission!);
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission!.branch }),
    );

    await git(repo, 'add', 'wip.ts');
    await git(repo, 'commit', '-m', 'commit my wip');
    await commitFile(repo, 'src/other/base.ts', 'export const other = 1;\n', 'later base work');

    await git(wt, 'rebase', state.base);
    await expect(
      git(repo, 'merge-base', '--is-ancestor', added.spawnBase!, mission!.branch),
    ).rejects.toThrow();

    await cleanReview('rev', mission!.branch);
    const { mergeCommit } = await store.merge(mission!.branch);
    expect(mergeCommit).toBe(await git(repo, 'rev-parse', 'HEAD'));
    expect((await store.load()).missions[0]?.status).toBe('merged');
    expect(await readFile(join(repo, 'src/x/x.ts'), 'utf8')).toBe('export const x = 1;\n');
    expect(await readFile(join(repo, 'src/other/base.ts'), 'utf8')).toBe(
      'export const other = 1;\n',
    );
  });

  it('merges when checkout dirt does not intersect the files the merge touches', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({ name: 'rev', kind: 'reviewer', reviewTarget: mission.branch }),
    );
    await cleanReview('rev', mission.branch);
    await writeFile(join(repo, 'scratch.txt'), 'unrelated wip\n');

    const { mergeCommit } = await store.merge(mission.branch);
    expect(mergeCommit).toBe(await git(repo, 'rev-parse', 'HEAD'));
    expect((await store.load()).missions[0]?.status).toBe('merged');
  });
});

describe('updateMission', () => {
  beforeEach(async () => {
    await store.init();
    await store.plan([
      { title: 'alpha', scope: ['src/alpha/**'], tasks: ['scaffold', 'implement'] },
      { title: 'beta', scope: ['src/beta/**'] },
    ]);
    await store.registerAgent(
      rosterEntry({ name: 'w1', kind: 'worker', missionId: 'M1', worktree: 'wt-1', branch: 'feat/alpha' }),
    );
  });

  it('rejects updates from a worker that does not own the mission', async () => {
    await expect(store.updateMission('w1', 'M2', { status: 'active' })).rejects.toThrow(
      /does not own mission M2/,
    );
    await expect(store.updateMission('ghost', 'M1', { status: 'active' })).rejects.toThrow(
      /does not own mission M1/,
    );
  });

  it('lets the owner worker update its own mission', async () => {
    const updated = await store.updateMission('w1', 'M1', { status: 'active', note: 'started' });
    expect(updated.status).toBe('active');
    expect(updated.notes).toContain('started');

    const withTask = await store.updateMission('w1', 'M1', { taskDone: 'scaffold' });
    expect(withTask.tasks.find((t) => t.text === 'scaffold')?.done).toBe(true);
  });

  it('rejects direct merged patches from both the owner worker and the tower', async () => {
    await expect(store.updateMission('w1', 'M1', { status: 'merged' })).rejects.toThrow(
      /only TowerMerge/,
    );
    await expect(store.updateMission('tower', 'M1', { status: 'merged' })).rejects.toThrow(
      /only TowerMerge/,
    );
    expect((await store.load()).missions[0]?.status).toBe('planned');
  });

  it('rejects task_done matching no open task', async () => {
    await expect(store.updateMission('w1', 'M1', { taskDone: 'no such task' })).rejects.toThrow(
      /no open task matching "no such task"/,
    );
    await store.updateMission('w1', 'M1', { taskDone: 'scaffold' });
    await expect(store.updateMission('w1', 'M1', { taskDone: 'scaffold' })).rejects.toThrow(
      /no open task matching/,
    );
  });

  it('keeps task ticks and no-op updates out of the activity log', async () => {
    await store.updateMission('w1', 'M1', { status: 'active' });
    const before = await store.recentLog(100);

    await store.updateMission('w1', 'M1', { taskDone: 'scaffold' });
    await store.updateMission('w1', 'M1', { status: 'active' });

    const after = await store.recentLog(100);
    expect(after.length).toBe(before.length);
    expect(after.join('\n')).not.toContain('task_done');
    const state = await store.load();
    expect(state.missions[0]?.tasks.find((t) => t.text === 'scaffold')?.done).toBe(true);
  });

  it('logs merge refusals with their reason', async () => {
    await setupMission({
      title: 'gamma',
      scope: 'src/gamma/**',
      file: 'src/gamma/gamma.ts',
      content: 'gamma\n',
    });
    await expect(store.merge('feat/gamma')).rejects.toThrow(/no review/);
    const log = (await store.recentLog(5)).join('\n');
    expect(log).toContain('merge.blocked');
    expect(log).toContain('branch=feat/gamma');
    expect(log).toContain('reason=no-review');
  });

  it('lets only the tower assign mission ownership', async () => {
    await expect(store.updateMission('w1', 'M1', { owner: 'w1' })).rejects.toThrow(
      /only the tower/,
    );
    const updated = await store.updateMission('tower', 'M1', { owner: 'w1' });
    expect(updated.owner).toBe('w1');
    const file = await readFile(join(repo, '.tower/comms/missions/M1-alpha.md'), 'utf8');
    expect(file).toContain('| feat/alpha | wt-1 | 🟡 | src/alpha/** | w1 |');
    const index = await readFile(join(repo, '.tower/comms/MISSIONS.md'), 'utf8');
    expect(index).toContain('| M1 | alpha | feat/alpha | wt-1 | 🟡 | w1 |');
  });

  it('lets only the tower abandon a mission, and logs it', async () => {
    await expect(store.updateMission('w1', 'M1', { status: 'abandoned' })).rejects.toThrow(
      /cannot abandon/,
    );
    expect((await store.load()).missions[0]?.status).toBe('planned');

    const abandoned = await store.updateMission('tower', 'M1', { status: 'abandoned' });
    expect(abandoned.status).toBe('abandoned');
    const index = await readFile(join(repo, '.tower/comms/MISSIONS.md'), 'utf8');
    expect(index).toContain('🚫');
    const log = (await store.recentLog(5)).join('\n');
    expect(log).toContain('mission.update');
    expect(log).toContain('status=abandoned');
  });

  it('does not reopen an abandoned mission but allows an exact no-op', async () => {
    await store.updateMission('tower', 'M1', { status: 'abandoned' });

    await expect(store.updateMission('tower', 'M1', { status: 'active' })).rejects.toThrow(
      /terminal/,
    );
    await expect(store.updateMission('w1', 'M1', { status: 'planned' })).rejects.toThrow(
      /terminal/,
    );
    await expect(store.updateMission('w1', 'M1', { blocker: 'reopen' })).rejects.toThrow(
      /terminal/,
    );
    expect((await store.updateMission('tower', 'M1', { status: 'abandoned' })).status).toBe(
      'abandoned',
    );
  });

  it('does not reopen or reclassify a merged mission but allows an exact no-op', async () => {
    const state = await store.load();
    const mission = state.missions[0]!;
    await store.addWorktree(mission.worktree, mission.branch, state.base);
    await commitFile(worktreeOf(mission), 'src/alpha/x.ts', 'x\n', 'work on M1');
    await store.updateMission('tower', mission.id, { taskDone: 'scaffold' });
    await store.updateMission('tower', mission.id, { taskDone: 'implement' });
    await completeMission(mission);
    await store.registerAgent(
      rosterEntry({
        name: 'rev',
        kind: 'reviewer',
        reviewTarget: mission.branch,
        reviewMissionId: mission.id,
      }),
    );
    await cleanReview('rev', mission.branch);
    await store.merge(mission.branch, { activeAgentIds: new Set() });

    await expect(store.updateMission('tower', 'M1', { status: 'active' })).rejects.toThrow(
      /terminal/,
    );
    await expect(store.updateMission('tower', 'M1', { status: 'abandoned' })).rejects.toThrow(
      /terminal/,
    );
    expect((await store.updateMission('tower', 'M1', { status: 'merged' })).status).toBe('merged');
  });

  it('serializes new plans into an open mission\'s scope with an auto dependency, and frees it on abandon', async () => {
    const [overlapping] = await store.plan([{ title: 'gamma overlap', scope: ['src/alpha/**'] }]);
    expect(overlapping!.deps).toEqual(['M1']);

    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    const [chained] = await store.plan([{ title: 'gamma chained', scope: ['src/alpha/**'] }]);
    expect(chained!.deps).toEqual(['M3']);

    await store.updateMission('tower', 'M3', { status: 'abandoned' });
    await store.updateMission('tower', 'M4', { status: 'abandoned' });
    const [gamma] = await store.plan([{ title: 'gamma fresh', scope: ['src/alpha/**'] }]);
    expect(gamma!.id).toBe('M5');
    expect(gamma!.deps).toEqual([]);
  });

  it('frees an abandoned mission\'s scope for scope patches', async () => {
    const patched = await store.updateMission('tower', 'M2', { scope: ['src/alpha/**'] });
    expect(patched.deps).toEqual(['M1']);

    await store.updateMission('tower', 'M1', { status: 'abandoned' });

    const repatched = await store.updateMission('tower', 'M2', { scope: ['src/alpha/**'] });
    expect(repatched.scope).toEqual(['src/alpha/**']);
    expect(repatched.deps).toEqual(['M1']);
  });
});

describe('concurrent state writes', () => {
  beforeEach(async () => {
    await store.init();
    await store.plan([
      { title: 'alpha', scope: ['src/alpha/**'], tasks: ['scaffold', 'implement'] },
    ]);
  });

  async function expectNoLockOrTmpLeftovers(): Promise<void> {
    const comms = await readdir(join(repo, '.tower/comms'));
    expect(comms.filter((name) => name.startsWith('state.json.'))).toEqual([]);
  }

  it('serializes same-process concurrent updateMission calls without lost updates or a torn state file', async () => {
    const notes = Array.from({ length: 8 }, (_, i) => `note-${String(i)}`);
    let reading = true;
    const reader = (async () => {
      for (;;) {
        if (!reading) return;
        JSON.parse(await readFile(store.abs(STATE_FILE), 'utf8'));
      }
    })();

    try {
      await Promise.all(notes.map((note) => store.updateMission('tower', 'M1', { note })));
    } finally {
      reading = false;
      await reader;
    }

    const state = await store.load();
    expect(state.missions[0]?.notes).toHaveLength(notes.length);
    expect(state.missions[0]?.notes).toEqual(expect.arrayContaining(notes));
    JSON.parse(await readFile(store.abs(STATE_FILE), 'utf8'));
    await expectNoLockOrTmpLeftovers();
  });

  it('serializes concurrent updateMission calls from two separate TowerStore instances', async () => {
    const other = new TowerStore(repo);
    const fromStore = Array.from({ length: 5 }, (_, i) => `store-${String(i)}`);
    const fromOther = Array.from({ length: 5 }, (_, i) => `other-${String(i)}`);

    await Promise.all([
      ...fromStore.map((note) => store.updateMission('tower', 'M1', { note })),
      ...fromOther.map((note) => other.updateMission('tower', 'M1', { note })),
    ]);

    const state = await store.load();
    expect(state.missions[0]?.notes).toHaveLength(fromStore.length + fromOther.length);
    expect(state.missions[0]?.notes).toEqual(
      expect.arrayContaining([...fromStore, ...fromOther]),
    );
    JSON.parse(await readFile(store.abs(STATE_FILE), 'utf8'));
    await expectNoLockOrTmpLeftovers();
  });

  it('surfaces a held state lock as a clear error instead of a hang or a silent skip', async () => {
    const lockPath = `${store.abs(STATE_FILE)}.lock`;
    await writeFile(lockPath, 'pid=999999 since=2026-09-26T00:00:00.000Z', 'utf8');
    const blocked = new TowerStore(repo, { stateLockTimeoutMs: 200, stateLockPollMs: 20 });

    await expect(blocked.updateMission('tower', 'M1', { note: 'x' })).rejects.toThrow(
      /timed out.*tower state lock.*held by pid=999999/s,
    );

    expect((await store.load()).missions[0]?.notes).toEqual([]);

    await rm(lockPath, { force: true });
    await store.updateMission('tower', 'M1', { note: 'after stale lock removed' });
    expect((await store.load()).missions[0]?.notes).toEqual(['after stale lock removed']);
    await expectNoLockOrTmpLeftovers();
  });

  it('a stale release cannot delete another holder\'s state lock', async () => {
    type LockDriver = { withStateLock: <T>(fn: () => Promise<T>) => Promise<T> };
    const drive = <T>(s: TowerStore, fn: () => Promise<T>): Promise<T> =>
      (s as unknown as LockDriver).withStateLock(fn);
    const lockPath = `${store.abs(STATE_FILE)}.lock`;
    const first = new TowerStore(repo);
    const impatient = new TowerStore(repo, { stateLockTimeoutMs: 150, stateLockPollMs: 20 });
    const second = new TowerStore(repo);

    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const firstRun = drive(first, async () => {
      markEntered();
      await gate;
    });
    await entered;

    await expect(drive(impatient, async () => undefined)).rejects.toThrow(/tower state lock/);

    await rm(lockPath, { force: true });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const secondRun = drive(second, async () => {
      await secondGate;
    });

    let heldContent = '';
    for (;;) {
      try {
        heldContent = await readFile(lockPath, 'utf8');
        break;
      } catch {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      }
    }
    expect(heldContent).toMatch(/pid=\d+ since=\S+ token=[0-9a-f-]+/);

    openGate();
    await firstRun;

    expect(await readFile(lockPath, 'utf8')).toBe(heldContent);

    releaseSecond();
    await secondRun;
    await expect(readFile(lockPath, 'utf8')).rejects.toThrow(/ENOENT/);
  });
});

describe('completion invariants', () => {
  beforeEach(async () => {
    await store.init();
  });

  async function seedMission(
    title: string,
    options: {
      tasks?: string[];
      kind?: 'build' | 'survey';
      withWorktree?: boolean;
      withCommit?: boolean;
    } = {},
  ): Promise<TowerMission> {
    const slug = title.replaceAll(' ', '-');
    const [mission] = await store.plan([
      { title, scope: [`src/${slug}/**`], tasks: options.tasks, kind: options.kind },
    ]);
    if (options.withWorktree === true || options.withCommit === true) {
      const state = await store.load();
      await store.addWorktree(mission!.worktree, mission!.branch, state.base);
    }
    if (options.withCommit === true) {
      await commitFile(worktreeOf(mission!), `src/${slug}/x.ts`, 'x\n', `work on ${mission!.id}`);
    }
    return mission!;
  }

  it('refuses completed while tasks are open and lists them in the error', async () => {
    const mission = await seedMission('feature x', {
      tasks: ['scaffold', 'implement'],
      withCommit: true,
    });

    await expect(
      store.updateMission('tower', mission.id, { status: 'completed' }),
    ).rejects.toThrow(/cannot transition to completed — 2 open task\(s\): "scaffold", "implement"/);
    await store.updateMission('tower', mission.id, { taskDone: 'scaffold' });
    await expect(
      store.updateMission('tower', mission.id, { status: 'completed' }),
    ).rejects.toThrow(/1 open task\(s\): "implement"/);

    expect((await store.load()).missions.find((m) => m.id === mission.id)?.status).toBe('planned');
  });

  it('lets a mission complete once every task is done or dropped', async () => {
    const mission = await seedMission('feature x', {
      tasks: ['scaffold', 'implement'],
      withCommit: true,
    });

    await store.updateMission('tower', mission.id, { taskDone: 'scaffold' });
    await store.updateMission('tower', mission.id, {
      taskDrop: { text: 'implement', reason: 'covered by another mission' },
    });

    const completed = await store.updateMission('tower', mission.id, { status: 'completed' });
    expect(completed.status).toBe('completed');
  });

  it('applies same-call task mutations before the completed gate', async () => {
    const mission = await seedMission('feature x', {
      tasks: ['scaffold', 'implement'],
      withCommit: true,
    });

    const completed = await store.updateMission('tower', mission.id, {
      taskDone: 'scaffold',
      taskDrop: { text: 'implement', reason: 'descoped, covered by M9' },
      status: 'completed',
    });

    expect(completed.status).toBe('completed');
    expect(completed.tasks.find((t) => t.text === 'scaffold')?.done).toBe(true);
    expect(completed.tasks.find((t) => t.text === 'implement')?.dropped).toBe(true);
  });

  it('refuses a combined patch that still leaves a task open, persisting nothing', async () => {
    const mission = await seedMission('feature x', {
      tasks: ['scaffold', 'implement'],
      withCommit: true,
    });

    await expect(
      store.updateMission('tower', mission.id, {
        taskDone: 'scaffold',
        status: 'completed',
      }),
    ).rejects.toThrow(/1 open task\(s\): "implement"/);

    const reloaded = (await store.load()).missions.find((m) => m.id === mission.id);
    expect(reloaded?.status).toBe('planned');
    expect(reloaded?.tasks.find((t) => t.text === 'scaffold')?.done).toBe(false);
  });

  it('gates a worker completing its own mission the same way', async () => {
    const mission = await seedMission('feature x', { tasks: ['scaffold'], withCommit: true });
    await store.registerAgent(
      rosterEntry({
        name: 'w1',
        kind: 'worker',
        missionId: mission.id,
        worktree: mission.worktree,
        branch: mission.branch,
      }),
    );

    await expect(store.updateMission('w1', mission.id, { status: 'completed' })).rejects.toThrow(
      /1 open task\(s\): "scaffold"/,
    );
    await store.updateMission('w1', mission.id, { taskDone: 'scaffold' });
    expect((await store.updateMission('w1', mission.id, { status: 'completed' })).status).toBe(
      'completed',
    );
  });

  it('requires a reason to drop a task and records the drop in notes and the activity log', async () => {
    const mission = await seedMission('feature x', {
      tasks: ['scaffold', 'implement'],
      withCommit: true,
    });

    await expect(
      store.updateMission('tower', mission.id, { taskDrop: { text: 'implement' } }),
    ).rejects.toThrow(/requires a reason/);
    await expect(
      store.updateMission('tower', mission.id, { taskDrop: { text: 'implement', reason: '  ' } }),
    ).rejects.toThrow(/requires a reason/);

    const updated = await store.updateMission('tower', mission.id, {
      taskDrop: { text: 'implement', reason: 'descoped, covered by M9' },
    });
    const dropped = updated.tasks.find((t) => t.text === 'implement');
    expect(dropped?.dropped).toBe(true);
    expect(dropped?.done).toBe(false);
    expect(updated.notes).toContain('dropped task "implement": descoped, covered by M9');
    const log = (await store.recentLog(10)).join('\n');
    expect(log).toContain('task_drop=dropped task "implement": descoped, covered by M9');
    const file = await readFile(
      join(repo, '.tower/comms/missions', `${mission.id}-feature-x.md`),
      'utf8',
    );
    expect(file).toContain('- [-] implement (dropped)');
  });

  it('does not match dropped tasks for task_done or a second drop', async () => {
    const mission = await seedMission('feature x', { tasks: ['implement'], withCommit: true });
    await store.updateMission('tower', mission.id, {
      taskDrop: { text: 'implement', reason: 'descoped' },
    });

    await expect(store.updateMission('tower', mission.id, { taskDone: 'implement' })).rejects.toThrow(
      /no open task matching "implement"/,
    );
    await expect(
      store.updateMission('tower', mission.id, {
        taskDrop: { text: 'implement', reason: 'again' },
      }),
    ).rejects.toThrow(/no open task matching "implement"/);
  });

  it('refuses completed for a build mission whose branch has no diff vs its base', async () => {
    const mission = await seedMission('feature x', { withWorktree: true });

    await expect(
      store.updateMission('tower', mission.id, { status: 'completed' }),
    ).rejects.toThrow(/has no changes vs "main"/);

    await commitFile(worktreeOf(mission), 'src/feature-x/x.ts', 'x\n', `work on ${mission.id}`);
    const completed = await store.updateMission('tower', mission.id, { status: 'completed' });
    expect(completed.status).toBe('completed');
  });

  it('refuses completed for a build mission whose branch does not exist', async () => {
    const mission = await seedMission('feature x');

    await expect(
      store.updateMission('tower', mission.id, { status: 'completed' }),
    ).rejects.toThrow(/does not exist, so no work has landed/);
  });

  it('lets a survey mission complete with no branch and no diff', async () => {
    const mission = await seedMission('scan layer', { kind: 'survey' });

    const completed = await store.updateMission('tower', mission.id, { status: 'completed' });
    expect(completed.status).toBe('completed');
  });

  it('still refuses a survey mission with open tasks', async () => {
    const mission = await seedMission('scan layer', { kind: 'survey', tasks: ['read the code'] });

    await expect(
      store.updateMission('tower', mission.id, { status: 'completed' }),
    ).rejects.toThrow(/1 open task\(s\): "read the code"/);
  });
});

describe('review round cap', () => {
  beforeEach(async () => {
    await store.init();
  });

  async function seedReviewedMission() {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.registerAgent(
      rosterEntry({
        name: 'rev',
        kind: 'reviewer',
        reviewTarget: mission.branch,
        reviewMissionId: mission.id,
      }),
    );
    return mission;
  }

  async function nonCleanRound(reviewer: string, target: string, findings: string): Promise<void> {
    await store.submitReview(reviewer, {
      target,
      status: 'p1-1items',
      merge: 'fix-then-merge',
      findings,
      decision: 'send it back',
    });
  }

  it('refuses a review beyond the round cap from the same reviewer and points at redirect', async () => {
    const mission = await seedReviewedMission();
    for (let i = 0; i < MAX_REVIEW_ROUNDS; i++) {
      await nonCleanRound('rev', mission.branch, `problem ${String(i)}`);
    }

    await expect(nonCleanRound('rev', mission.branch, 'still broken')).rejects.toThrow(
      /5 review rounds by "rev".*redirect instead: reassign/s,
    );

    const reviews = await store.reviewsFor(mission.branch);
    expect(reviews.map((r) => r.round)).toEqual([1, 2, 3, 4, 5]);
  });

  it('lets a fresh reviewer start at round 1 on a capped branch', async () => {
    const mission = await seedReviewedMission();
    for (let i = 0; i < MAX_REVIEW_ROUNDS; i++) {
      await nonCleanRound('rev', mission.branch, `problem ${String(i)}`);
    }
    await store.registerAgent(
      rosterEntry({
        name: 'rev-2',
        kind: 'reviewer',
        reviewTarget: mission.branch,
        reviewMissionId: mission.id,
      }),
    );

    await nonCleanRound('rev-2', mission.branch, 'fresh eyes');

    const reviews = await store.reviewsFor(mission.branch);
    expect(reviews).toHaveLength(MAX_REVIEW_ROUNDS + 1);
    expect(reviews.at(-1)?.reviewer).toBe('rev-2');
    expect(reviews.at(-1)?.round).toBe(1);
  });
});

describe('roster', () => {
  beforeEach(async () => {
    await store.init();
  });

  it('rejects duplicate agent names', async () => {
    await store.registerAgent(rosterEntry({ name: 'w1', kind: 'worker' }));
    await expect(
      store.registerAgent(rosterEntry({ name: 'w1', kind: 'reviewer', agentId: 'agent-w1-reviewer' })),
    ).rejects.toThrow(/already registered/);
  });

  it('resolveCallerName maps main to tower, resolves roster agents, rejects strangers', async () => {
    await store.registerAgent(rosterEntry({ name: 'w1', kind: 'worker' }));
    const state = await store.load();
    expect(store.resolveCallerName(state, 'main')).toBe('tower');
    expect(store.resolveCallerName(state, 'agent-w1')).toBe('w1');
    expect(() => store.resolveCallerName(state, 'agent-99')).toThrow(TowerProtocolError);
  });

  it('re-registering an agent id retires the stale entry so identity follows the latest registration', async () => {
    await store.registerAgent(
      rosterEntry({ name: 'worker-old', kind: 'worker', agentId: 'agent-1', sessionId: 'session-a' }),
    );
    await store.registerAgent(
      rosterEntry({ name: 'worker-new', kind: 'worker', agentId: 'agent-1', sessionId: 'session-b' }),
    );

    const state = await store.load();
    expect(state.roster.agents.map((agent) => agent.name)).toEqual(['worker-new']);
    expect(store.resolveCallerName(state, 'agent-1')).toBe('worker-new');
  });

  async function seedDuplicatedRoster(): Promise<void> {
    const file = store.abs(STATE_FILE);
    const state = JSON.parse(await readFile(file, 'utf8')) as TowerState;
    state.roster.agents.push(
      rosterEntry({
        name: 'worker-old',
        kind: 'worker',
        agentId: 'agent-1',
        sessionId: 'session-a',
        spawnedAt: '2026-09-13T08:00:00.000Z',
      }),
      rosterEntry({
        name: 'worker-new',
        kind: 'worker',
        agentId: 'agent-1',
        sessionId: 'session-b',
        spawnedAt: '2026-09-14T03:00:00.000Z',
      }),
    );
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
  }

  it('resolves a duplicated agent id to its latest roster entry — stale sessions lose', async () => {
    await seedDuplicatedRoster();

    const state = await store.load();
    expect(store.resolveCallerName(state, 'agent-1')).toBe('worker-new');
    expect(store.resolveAgent(state, 'agent-1')?.name).toBe('worker-new');
  });

  it('marks and clears death on the latest entry when an agent id is duplicated', async () => {
    await seedDuplicatedRoster();

    const died = await store.markAgentDied('agent-1', 'failed');
    expect(died?.name).toBe('worker-new');
    let state = await store.load();
    expect(state.roster.agents[0]?.diedAt).toBeUndefined();
    expect(state.roster.agents[1]?.diedAt).toBeDefined();

    expect(await store.clearAgentDied('agent-1')).toBe(true);
    state = await store.load();
    expect(state.roster.agents[1]?.diedAt).toBeUndefined();
  });

  it('attributes died and revived activity-log entries with the writing session and pid', async () => {
    await store.registerAgent(rosterEntry({ name: 'w1', kind: 'worker', agentId: 'agent-w1' }));

    await store.markAgentDied('agent-w1', 'killed', 'stopped by the user', 'session-writer');
    const diedLog = (await store.recentLog(5)).join('\n');
    expect(diedLog).toContain(' died ');
    expect(diedLog).toContain('session=session-writer');
    expect(diedLog).toContain(`pid=${String(process.pid)}`);

    expect(await store.clearAgentDied('agent-w1', 'session-writer')).toBe(true);
    const revivedLog = (await store.recentLog(5)).join('\n');
    expect(revivedLog).toContain(' revived ');
    expect(revivedLog).toContain('session=session-writer');
    expect(revivedLog).toContain(`pid=${String(process.pid)}`);
  });
});

describe('adopt', () => {
  it('retires a foreign session roster without requiring TowerInit', async () => {
    await store.init('session-a');
    await store.registerAgent(rosterEntry({ name: 'w1', kind: 'worker', sessionId: 'session-a' }));

    const retired = await store.adopt('session-b');

    expect(retired).toEqual(['w1']);
    const state = await store.load();
    expect(state.sessionId).toBe('session-b');
    expect(state.roster.agents).toEqual([]);
  });

  it('keeps the roster when the adopting session already owns the workspace', async () => {
    await store.init('session-a');
    await store.registerAgent(rosterEntry({ name: 'w1', kind: 'worker', sessionId: 'session-a' }));

    expect(await store.adopt('session-a')).toEqual([]);
    expect((await store.load()).roster.agents).toHaveLength(1);
  });

  it('no-ops on an uninitialized workspace', async () => {
    expect(await store.adopt('session-b')).toEqual([]);
    expect(await store.isInitialized()).toBe(false);
  });

  it('propagates an unreadable state file instead of treating it as uninitialized', async () => {
    await store.init('session-a');
    await rm(store.abs(STATE_FILE), { recursive: true, force: true });
    await mkdir(store.abs(STATE_FILE));

    await expect(store.adopt('session-b')).rejects.toThrow();
  });
});

describe('teardown', () => {
  beforeEach(async () => {
    await store.init();
  });

  it('keeps dirty worktrees by default and removes them with force', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    const wt = worktreeOf(mission);
    await writeFile(join(wt, 'uncommitted.txt'), 'dirty\n');

    const report = await store.teardown();
    expect(report.join('\n')).toContain(`kept .tower/worktrees/${mission.worktree}`);
    expect((await stat(wt)).isDirectory()).toBe(true);

    const forced = await store.teardown({ force: true });
    expect(forced.join('\n')).toContain(`removed .tower/worktrees/${mission.worktree}`);
    await expect(stat(wt)).rejects.toThrow();
  });

  it('removes clean worktrees without force', async () => {
    const mission = await setupMission({
      title: 'feature y',
      scope: 'src/y/**',
      file: 'src/y/y.ts',
      content: 'y\n',
    });
    const wt = worktreeOf(mission);
    const report = await store.teardown();
    expect(report.join('\n')).toContain(`removed .tower/worktrees/${mission.worktree}`);
    await expect(stat(wt)).rejects.toThrow();
  });

  it('removes mission worktrees when the repository path contains a newline', async () => {
    const nlRepo = await mkdtemp(join(tmpdir(), 'tower-store-nl\n-'));
    try {
      await git(nlRepo, 'init', '-b', 'main');
      await git(nlRepo, 'config', 'user.email', 'tower-test@example.com');
      await git(nlRepo, 'config', 'user.name', 'Tower Test');
      await commitFile(nlRepo, 'README.md', '# fixture\n', 'initial');
      const nlStore = new TowerStore(nlRepo);
      await nlStore.init();
      const [mission] = await nlStore.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
      const state = await nlStore.load();
      await nlStore.addWorktree(mission!.worktree, mission!.branch, state.base);

      const report = await nlStore.teardown();

      expect(report).toEqual([`removed .tower/worktrees/${mission!.worktree}`]);
    } finally {
      await rm(nlRepo, { recursive: true, force: true });
    }
  });

  it('removes mission worktrees when the tower runs inside a linked git worktree', async () => {
    const linked = join(await mkdtemp(join(tmpdir(), 'tower-store-linked-')), 'linked');
    await git(repo, 'worktree', 'add', linked, '-b', 'linked-checkout');
    try {
      const linkedStore = new TowerStore(linked);
      await linkedStore.init();
      const [mission] = await linkedStore.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
      const state = await linkedStore.load();
      await linkedStore.addWorktree(mission!.worktree, mission!.branch, state.base);

      const report = await linkedStore.teardown();

      expect(report).toEqual([`removed .tower/worktrees/${mission!.worktree}`]);
    } finally {
      await git(repo, 'worktree', 'remove', '--force', linked).catch(() => {});
      await git(repo, 'branch', '-D', 'linked-checkout').catch(() => {});
    }
  });

  it('treats a worktree git no longer knows as already removed, not as a failure', async () => {
    const mission = await setupMission({
      title: 'feature gone',
      scope: 'src/gone/**',
      file: 'src/gone/gone.ts',
      content: 'gone\n',
    });
    await git(repo, 'worktree', 'remove', '--force', worktreeOf(mission));

    const report = await store.teardown();
    expect(report.join('\n')).toContain(`already removed .tower/worktrees/${mission.worktree}`);
    expect(report.join('\n')).not.toContain('failed');
    const log = (await store.recentLog(20)).join('\n');
    expect(log).not.toContain('worktree.remove.failed');
  });

  it('is idempotent across consecutive runs', async () => {
    const clean = await setupMission({
      title: 'feature idem clean',
      scope: 'src/idem-clean/**',
      file: 'src/idem-clean/c.ts',
      content: 'c\n',
    });
    const dirty = await setupMission({
      title: 'feature idem dirty',
      scope: 'src/idem-dirty/**',
      file: 'src/idem-dirty/d.ts',
      content: 'd\n',
    });
    await writeFile(join(worktreeOf(dirty), 'uncommitted.txt'), 'dirty\n');

    const first = await store.teardown();
    expect(first.join('\n')).toContain(`removed .tower/worktrees/${clean.worktree}`);
    expect(first.join('\n')).toContain(`kept .tower/worktrees/${dirty.worktree}`);

    const second = await store.teardown();
    expect(second.join('\n')).toContain(`already removed .tower/worktrees/${clean.worktree}`);
    expect(second.join('\n')).toContain(`kept .tower/worktrees/${dirty.worktree}`);
    expect(second.join('\n')).not.toContain('failed');
    const log = (await store.recentLog(50)).join('\n');
    expect(log).not.toContain('worktree.remove.failed');
  });

  it('still records a failure when git refuses to remove a known worktree', async () => {
    const mission = await setupMission({
      title: 'feature locked',
      scope: 'src/locked/**',
      file: 'src/locked/l.ts',
      content: 'l\n',
    });
    await git(repo, 'worktree', 'lock', worktreeOf(mission));

    const report = await store.teardown();
    expect(report.join('\n')).toContain(`failed to remove .tower/worktrees/${mission.worktree}`);
    const log = (await store.recentLog(20)).join('\n');
    expect(log).toContain('worktree.remove.failed');
  });

  it('removes clean worktrees that contain an initialized submodule', async () => {
    const subRepo = await mkdtemp(join(tmpdir(), 'tower-sub-test-'));
    try {
      await git(subRepo, 'init', '-b', 'main');
      await git(subRepo, 'config', 'user.email', 'tower-test@example.com');
      await git(subRepo, 'config', 'user.name', 'Tower Test');
      await commitFile(subRepo, 'lib.txt', 'lib\n', 'lib initial');
      await git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', subRepo, 'vendor/lib');
      await git(repo, 'commit', '-m', 'add vendor/lib submodule');

      const mission = await setupMission({
        title: 'feature z',
        scope: 'src/z/**',
        file: 'src/z/z.ts',
        content: 'z\n',
      });
      const wt = worktreeOf(mission);
      await git(wt, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init');

      const report = await store.teardown();
      expect(report.join('\n')).toContain(`removed .tower/worktrees/${mission.worktree}`);
      await expect(stat(wt)).rejects.toThrow();
    } finally {
      await rm(subRepo, { recursive: true, force: true });
    }
  });

  it('keeps worktrees whose roster agent is live, and force does not override that', async () => {
    const mission = await setupMission({
      title: 'feature live',
      scope: 'src/live/**',
      file: 'src/live/l.ts',
      content: 'l\n',
    });
    await store.registerAgent(
      rosterEntry({
        name: 'w-live',
        kind: 'worker',
        agentId: 'agent-live',
        worktree: mission.worktree,
      }),
    );
    const live = new Set(['agent-live']);

    const report = await store.teardown({ liveAgentIds: live });
    expect(report.join('\n')).toContain(
      `kept .tower/worktrees/${mission.worktree} (live agent: w-live)`,
    );
    expect((await stat(worktreeOf(mission))).isDirectory()).toBe(true);

    const forced = await store.teardown({ force: true, liveAgentIds: live });
    expect(forced.join('\n')).toContain(
      `kept .tower/worktrees/${mission.worktree} (live agent: w-live)`,
    );
    expect((await stat(worktreeOf(mission))).isDirectory()).toBe(true);

    const settled = await store.teardown({ liveAgentIds: new Set() });
    expect(settled.join('\n')).toContain(`removed .tower/worktrees/${mission.worktree}`);
    await expect(stat(worktreeOf(mission))).rejects.toThrow();
  });

  it('skips worktrees named in exclude and reports excluded names that match nothing', async () => {
    const mission = await setupMission({
      title: 'feature excluded',
      scope: 'src/excluded/**',
      file: 'src/excluded/e.ts',
      content: 'e\n',
    });

    const report = await store.teardown({ exclude: [mission.worktree, 'wt-999'] });
    expect(report.join('\n')).toContain(`kept .tower/worktrees/${mission.worktree} (excluded)`);
    expect(report.join('\n')).toContain('excluded worktree "wt-999" matched no mission worktree');
    expect((await stat(worktreeOf(mission))).isDirectory()).toBe(true);

    const after = await store.teardown();
    expect(after.join('\n')).toContain(`removed .tower/worktrees/${mission.worktree}`);
  });

  it('dry run reports the decisions without changing worktrees, state, or the log', async () => {
    const clean = await setupMission({
      title: 'feature dry clean',
      scope: 'src/dry-clean/**',
      file: 'src/dry-clean/c.ts',
      content: 'c\n',
    });
    const dirty = await setupMission({
      title: 'feature dry dirty',
      scope: 'src/dry-dirty/**',
      file: 'src/dry-dirty/d.ts',
      content: 'd\n',
    });
    await writeFile(join(worktreeOf(dirty), 'uncommitted.txt'), 'dirty\n');
    const gone = await setupMission({
      title: 'feature dry gone',
      scope: 'src/dry-gone/**',
      file: 'src/dry-gone/g.ts',
      content: 'g\n',
    });
    await git(repo, 'worktree', 'remove', '--force', worktreeOf(gone));
    const live = await setupMission({
      title: 'feature dry live',
      scope: 'src/dry-live/**',
      file: 'src/dry-live/l.ts',
      content: 'l\n',
    });
    await store.registerAgent(
      rosterEntry({
        name: 'w-dry-live',
        kind: 'worker',
        agentId: 'agent-dry-live',
        worktree: live.worktree,
      }),
    );
    const logBefore = await store.recentLog(200);

    const report = await store.teardown({
      dryRun: true,
      exclude: [gone.worktree],
      liveAgentIds: new Set(['agent-dry-live']),
    });
    const text = report.join('\n');
    expect(text).toContain(`would remove .tower/worktrees/${clean.worktree}`);
    expect(text).toContain(`would keep .tower/worktrees/${dirty.worktree} (uncommitted changes`);
    expect(text).toContain(`would keep .tower/worktrees/${live.worktree} (live agent: w-dry-live)`);
    expect(text).toContain(`already removed .tower/worktrees/${gone.worktree}`);
    expect(text).not.toMatch(/(^|\n)removed \.tower\/worktrees/);
    expect(text).not.toContain(`excluded worktree "${gone.worktree}" matched no mission worktree`);
    expect((await stat(worktreeOf(clean))).isDirectory()).toBe(true);
    expect((await stat(worktreeOf(dirty))).isDirectory()).toBe(true);
    expect((await stat(worktreeOf(live))).isDirectory()).toBe(true);
    expect(await store.recentLog(200)).toEqual(logBefore);

    const real = await store.teardown({ liveAgentIds: new Set(['agent-dry-live']) });
    expect(real.join('\n')).toContain(`removed .tower/worktrees/${clean.worktree}`);
    expect(real.join('\n')).toContain(`kept .tower/worktrees/${live.worktree} (live agent: w-dry-live)`);
  });
});

describe('addWorktree branch ownership', () => {
  beforeEach(async () => {
    await store.init();
  });

  it('refuses to build on a branch that appeared in git after planning without tower ownership', async () => {
    const [mission] = await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    await git(repo, 'branch', mission!.branch);

    const state = await store.load();
    await expect(store.addWorktree(mission!.worktree, mission!.branch, state.base)).rejects.toThrow(
      /not owned by any tower mission/,
    );
  });

  it('creates the mission branch atomically, refusing an existing ref instead of checking it out', async () => {
    await git(repo, 'branch', 'feat/taken');
    const target = join(repo, 'wt-taken');

    await expect(worktreeAddNewBranch(repo, target, 'feat/taken', 'main')).rejects.toThrow(
      /already exists/,
    );

    const listed = await git(repo, 'worktree', 'list', '--porcelain');
    expect(listed).not.toContain('wt-taken');
  });

  it('refuses to attach when an unowned branch exists and the worktree path is only a plain directory', async () => {
    const [mission] = await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    await git(repo, 'branch', mission!.branch);
    await mkdir(worktreeOf(mission!), { recursive: true });

    const state = await store.load();
    await expect(store.addWorktree(mission!.worktree, mission!.branch, state.base)).rejects.toThrow(
      /not owned by any tower mission/,
    );
  });

  it('does not apply the ownership refusal to a registered worktree left by an earlier spawn attempt', async () => {
    const [mission] = await store.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
    const state = await store.load();
    await store.addWorktree(mission!.worktree, mission!.branch, state.base);

    const retry = await store
      .addWorktree(mission!.worktree, mission!.branch, state.base)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(retry).toBeInstanceOf(Error);
    expect((retry as Error).message).not.toMatch(/not owned by any tower mission/);
  });

  it('allows re-adding the worktree of a mission that already has an owner', async () => {
    const mission = await setupMission({
      title: 'feature x',
      scope: 'src/x/**',
      file: 'src/x/x.ts',
      content: 'x\n',
    });
    await store.updateMission('tower', mission.id, { owner: 'w1' });
    const wt = worktreeOf(mission);
    await git(repo, 'worktree', 'remove', '--force', wt);

    const state = await store.load();
    const added = await store.addWorktree(mission.worktree, mission.branch, state.base);

    expect(added.spawnBase).toBeUndefined();
    expect(await readFile(join(wt, 'src/x/x.ts'), 'utf8')).toBe('x\n');
  });
});


describe('scopesOverlap', () => {
  it('detects identical and nested directory globs', () => {
    expect(scopesOverlap(['src/a/**'], ['src/a/**'])).toBe(true);
    expect(scopesOverlap(['src/a/**'], ['src/a/b/**'])).toBe(true);
    expect(scopesOverlap(['src/a/b/**'], ['src/a/**'])).toBe(true);
    expect(scopesOverlap(['src/a/**'], ['src/b/**'])).toBe(false);
  });

  it('normalizes trailing slashes and only treats path-boundary prefixes as overlapping', () => {
    expect(scopesOverlap(['src/a/'], ['src/a'])).toBe(true);
    expect(scopesOverlap(['src/a'], ['src/ab'])).toBe(false);
    expect(scopesOverlap(['src/ab'], ['src/a'])).toBe(false);
  });

  it('treats single-level star globs as their parent directory, conservatively including deeper paths', () => {
    expect(scopesOverlap(['src/*'], ['src/foo.ts'])).toBe(true);
    expect(scopesOverlap(['src/*'], ['src/foo/bar/**'])).toBe(true);
  });

  it('does not detect overlap for mid-path wildcards (stem heuristic limitation)', () => {
    expect(scopesOverlap(['src/*.ts'], ['src/foo.ts'])).toBe(false);
    expect(scopesOverlap(['src/**/foo.ts'], ['src/a/foo.ts'])).toBe(false);
  });

  it('skips empty stems and empty scope lists', () => {
    expect(scopesOverlap(['**'], ['src/a/**'])).toBe(false);
    expect(scopesOverlap([], ['src/a/**'])).toBe(false);
    expect(scopesOverlap(['src/a/**'], [])).toBe(false);
  });
});
