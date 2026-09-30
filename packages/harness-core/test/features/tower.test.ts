import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHistoryMessageBuilder,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  systemReminderText,
  Trees,
  UNKNOWN_CAPABILITY,
  useAgent,
  useAgentTools,
  createFeature,
  type AgentCommands,
  type AgentHandle,
  type FeatureSpec,
  type HistoryMessage,
  type LlmModel,
  type LlmRequester,
  type Message,
  type SessionStores,
  type ToolDescription,
  type ToolMeta,
} from '@moonshot-ai/agent-core';

import { createNodeOsHost, type OsHost } from '#/features/os/host/index';
import { interaction } from '#/features/interaction/index';
import { createPlan, PlanRef } from '#/features/plan/index';
import { createProfiles, ProfileCatalogRef } from '#/features/profiles/index';
import { createSpawn, type SpawnModelEntry } from '#/features/spawn/index';
import { createTask } from '#/features/task/index';
import {
  createTower,
  createTowerInjection,
  createTowerRateLimiter,
  Git,
  TOWER_INBOX_WAKE_VARIANT,
  TOWER_WORKER_PROFILE,
  TOWER_WORKER_PROFILE_DEF,
  TowerProtocolError,
  TowerRef,
  TowerStore,
  resolveTowerRepoRoot,
  towerEnterFailureMessage,
  type TowerEnterFailure,
  type TowerIo,
} from '#/features/tower/index';

import TOWER_MODE_EXIT_REMINDER from '../../src/features/tower/injection/tower-mode-exit-reminder.md?raw';
import TOWER_MODE_FULL_REMINDER from '../../src/features/tower/injection/tower-mode-full-reminder.md?raw';
import TOWER_MODE_SPARSE_REMINDER from '../../src/features/tower/injection/tower-mode-sparse-reminder.md?raw';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trimEnd();
}

const tmpDirs: string[] = [];

afterEach(async () => {
  delete process.env['KIMI_CODE_EXPERIMENTAL_TOWER'];
  delete process.env['KIMI_CODE_EXPERIMENTAL_FLAG'];
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

async function tmpRepo(prefix = 'tower-repo-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'tower-test@example.com');
  await git(dir, 'config', 'user.name', 'Tower Test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

async function commitFile(repo: string, rel: string, content: string, message: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(repo, rel, '..'), { recursive: true });
  await writeFile(join(repo, rel), content);
  await git(repo, 'add', rel);
  await git(repo, 'commit', '-m', message);
}

let sharedHost: OsHost | undefined;

function testIo(): TowerIo {
  sharedHost ??= createNodeOsHost();
  return { fs: sharedHost.fs, git: new Git({ process: sharedHost.process, fs: sharedHost.fs }) };
}

function testStore(repo: string): TowerStore {
  return new TowerStore(repo, testIo());
}

async function activityLog(repo: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(join(repo, '.tower', 'comms', 'log', 'activity.log'), 'utf8');
}

describe('store: init and ownership', () => {
  it('bootstraps an empty non-git directory with git init and an empty initial commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tower-empty-'));
    tmpDirs.push(dir);
    const result = await testStore(dir).init('session-a');
    expect(result.created).toBe(true);
    const branch = await git(dir, 'symbolic-ref', '--short', 'HEAD');
    expect(result.base).toBe(branch);
    expect(await git(dir, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(await git(dir, 'log', '-1', '--format=%s')).toBe('tower: init');
    expect(await git(dir, 'status', '--porcelain')).toBe('');
  });

  it('snapshots the existing files of a non-empty directory onto the requested base', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tower-nonempty-'));
    tmpDirs.push(dir);
    await writeFile(join(dir, 'notes.txt'), 'hello');
    const result = await testStore(dir).init('session-a', 'tower-base');
    expect(result.base).toBe('tower-base');
    expect(await git(dir, 'log', '-1', '--format=%s')).toBe(
      'tower: snapshot of uncommitted base checkout changes (base tower-base)',
    );
    expect(await git(dir, 'ls-files')).toContain('notes.txt');
    expect(await git(dir, 'status', '--porcelain')).toBe('');
  });

  it('creates the directory skeleton, state.json, and the git exclude entry', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const store = testStore(repo);
    const result = await store.init();
    expect(result.created).toBe(true);
    expect(result.base).toBe('main');
    const state = await store.load();
    expect(state.sessionId).toBeUndefined();
    expect(state.roster.agents).toEqual([]);
    const { readFile } = await import('node:fs/promises');
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').map((line) => line.trim())).toContain('.tower/');
    expect((await activityLog(repo)).trim().split('\n').some((line) => line.includes(' init '))).toBe(true);
  });

  it('is idempotent — a second init reports created:false and preserves state', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const store = testStore(repo);
    await store.init('session-a');
    const second = await store.init('session-a');
    expect(second.created).toBe(false);
    expect(second.retiredAgents).toEqual([]);
  });

  it('rejects a base that is not a local branch and stays uninitialized', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const store = testStore(repo);
    await expect(store.init(undefined, 'no-such-branch')).rejects.toThrow(
      'base branch "no-such-branch" does not exist as a local branch',
    );
    expect(await store.isInitialized()).toBe(false);
  });

  it('refuses a detached HEAD without an explicit base', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a', 'initial');
    await git(repo, 'checkout', '--detach', 'HEAD');
    await expect(testStore(repo).init()).rejects.toThrow(/detached HEAD/);
  });

  it('adopts a foreign session roster, retiring its agents, and releases ownership', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const store = testStore(repo);
    await store.init('session-a');
    await store.registerAgent({
      name: 'agent-build',
      agentId: 'subagent-1',
      sessionId: 'session-a',
      kind: 'worker',
      spawnedAt: new Date().toISOString(),
    });
    const retired = await store.adopt('session-b');
    expect(retired).toEqual(['agent-build']);
    expect((await store.load()).sessionId).toBe('session-b');
    await store.release('session-a');
    expect((await store.load()).sessionId).toBe('session-b');
    await store.release('session-b');
    expect((await store.load()).sessionId).toBeUndefined();
    const log = await activityLog(repo);
    expect(log).toContain(' adopt ');
    expect(log).toContain(' release ');
  });

  it('adopt no-ops on an uninitialized workspace', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a', 'initial');
    expect(await testStore(repo).adopt('session-b')).toEqual([]);
  });
});

describe('store: roster', () => {
  it('rejects reserved, blank, and duplicate names; resolves callers', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const store = testStore(repo);
    await store.init('session-a');
    const entry = {
      name: 'agent-build',
      agentId: 'subagent-1',
      sessionId: 'session-a',
      kind: 'worker' as const,
      spawnedAt: new Date().toISOString(),
    };
    await store.registerAgent(entry);
    await expect(store.registerAgent({ ...entry, agentId: 'subagent-2' })).rejects.toThrow(
      'tower agent name "agent-build" is already registered',
    );
    await expect(store.registerAgent({ ...entry, name: 'tower', agentId: 'subagent-2' })).rejects.toThrow(
      'tower agent name "tower" is reserved by the tower protocol — pick a different name',
    );
    await expect(store.registerAgent({ ...entry, name: ' padded ', agentId: 'subagent-2' })).rejects.toThrow(
      'tower agent name " padded " must not be blank or carry surrounding whitespace',
    );
    const state = await store.load();
    expect(store.resolveCallerName(state, 'main')).toBe('tower');
    expect(store.resolveCallerName(state, 'subagent-1')).toBe('agent-build');
    expect(() => store.resolveCallerName(state, 'stranger')).toThrow(
      'agent "stranger" is not a tower participant — only spawned workers/reviewers and the tower can use tower tools',
    );
  });

  it('marks and clears agent death with activity log lines', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const store = testStore(repo);
    await store.init('session-a');
    await store.registerAgent({
      name: 'agent-build',
      agentId: 'subagent-1',
      sessionId: 'session-a',
      kind: 'worker',
      spawnedAt: new Date().toISOString(),
    });
    const died = await store.markAgentDied('subagent-1', 'failed', 'boom');
    expect(died?.deathStatus).toBe('failed');
    expect((await store.load()).roster.agents[0]?.diedAt).toBeDefined();
    expect(await store.markAgentDied('unknown', 'failed')).toBeUndefined();
    expect(await store.clearAgentDied('subagent-1')).toBe(true);
    expect((await store.load()).roster.agents[0]?.diedAt).toBeUndefined();
    const log = await activityLog(repo);
    expect(log).toContain(' died ');
    expect(log).toContain(' revived ');
  });
});

describe('store: plan and missions', () => {
  it('writes missions to state and renders MISSIONS.md plus mission files', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const store = testStore(repo);
    await store.init('session-a');
    const missions = await store.plan([
      { title: 'Build API', scope: ['src/api/**'], tasks: ['add route'], context: 'keep it REST' },
      { title: 'Survey UI', scope: ['src/ui/**'], kind: 'survey' },
    ]);
    expect(missions.map((m) => m.id)).toEqual(['M1', 'M2']);
    expect(missions[0]).toMatchObject({
      branch: 'feat/build-api',
      worktree: 'wt-1',
      status: 'planned',
      kind: 'build',
      context: 'keep it REST',
    });
    expect(missions[1]?.kind).toBe('survey');
    const { readFile } = await import('node:fs/promises');
    const index = await readFile(join(repo, '.tower', 'comms', 'MISSIONS.md'), 'utf8');
    expect(index).toContain('| M1 | Build API | feat/build-api | wt-1 | 🟡 | — |');
    expect(index).toContain('- M2 (survey — informational, reserves nothing): src/ui/**');
    const missionFile = await readFile(
      join(repo, '.tower', 'comms', 'missions', 'M1-build-api.md'),
      'utf8',
    );
    expect(missionFile).toContain("# Mission M1: Build API");
    expect(missionFile).toContain("- [ ] add route");
    expect(missionFile).toContain("## Context — the user's own words, verbatim");
  });

  it('rejects overlapping scopes, unknown deps, and branch collisions; surveys reserve nothing', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const store = testStore(repo);
    await store.init('session-a');
    await store.plan([{ title: 'API', scope: ['src/api/**'] }]);
    await expect(store.plan([{ title: 'API 2', scope: ['src/api/inner/**'] }])).rejects.toThrow(
      'mission scopes overlap: M1 ("src/api/**") vs M2 ("src/api/inner/**")',
    );
    await expect(store.plan([{ title: 'Other', scope: ['src/other/**'], deps: ['M9'] }])).rejects.toThrow(
      'mission M2 depends on unknown mission "M9"',
    );
    await expect(store.plan([{ title: 'API', scope: ['src/other/**'] }])).rejects.toThrow(
      'mission M2 branch "feat/api" is already used by M1 (planned) "API"',
    );
    const survey = await store.plan([
      { title: 'Survey API', scope: ['src/api/**'], kind: 'survey' },
    ]);
    expect(survey[0]?.kind).toBe('survey');
  });

  it('updateMission enforces worker ownership and tower-only fields', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const store = testStore(repo);
    await store.init('session-a');
    const [mission] = await store.plan([{ title: 'API', scope: ['src/api/**'], tasks: ['route'] }]);
    await store.registerAgent({
      name: 'agent-build',
      agentId: 'subagent-1',
      sessionId: 'session-a',
      kind: 'worker',
      missionId: mission.id,
      spawnedAt: new Date().toISOString(),
    });
    await expect(
      store.updateMission('agent-build', mission.id, { status: 'abandoned' }),
    ).rejects.toThrow(
      `agent "agent-build" cannot abandon mission ${mission.id} — abandoning releases the mission scope, so only the tower does it`,
    );
    await expect(
      store.updateMission('agent-build', mission.id, { scope: ['src/wider/**'] }),
    ).rejects.toThrow(
      'agent "agent-build" cannot change mission scope — only the tower widens a scope, and every change is logged',
    );
    const updated = await store.updateMission('agent-build', mission.id, { taskDone: 'route' });
    expect(updated.tasks[0]?.done).toBe(true);
    const blocked = await store.updateMission('agent-build', mission.id, { blocker: 'stuck' });
    expect(blocked.status).toBe('blocked');
    expect(blocked.blockers).toEqual(['stuck']);
    const abandoned = await store.updateMission('tower', mission.id, { status: 'abandoned' });
    expect(abandoned.status).toBe('abandoned');
  });

  it('rebase refuses while missions are open and keeps the recorded base', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a', 'initial');
    await git(repo, 'branch', 'develop');
    const store = testStore(repo);
    await store.init('session-a', 'main');
    await store.plan([{ title: 'API', scope: ['src/api/**'] }]);
    await expect(store.rebase('develop')).rejects.toThrow(
      'cannot rebase the tower from "main" to "develop" — 1 mission(s) are still open (M1)',
    );
    expect((await store.load()).base).toBe('main');
    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    await store.rebase('develop');
    expect((await store.load()).base).toBe('develop');
  });
});

describe('store: inbox and findings', () => {
  it('sends, routes visibility, and rejects unknown or self recipients', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const store = testStore(repo);
    await store.init('session-a');
    await store.registerAgent({
      name: 'agent-build',
      agentId: 'subagent-1',
      sessionId: 'session-a',
      kind: 'worker',
      spawnedAt: new Date().toISOString(),
    });
    await expect(
      store.send('agent-build', { to: 'nobody', subject: 'hi', body: 'x' }),
    ).rejects.toThrow(
      'unknown recipient "nobody" — address a roster agent, tower, or all (known: tower, all, agent-build)',
    );
    await expect(
      store.send('agent-build', { to: 'agent-build', subject: 'hi', body: 'x' }),
    ).rejects.toThrow('cannot send an inbox message to yourself');
    await store.send('agent-build', { to: 'tower', subject: 'report', body: 'done', scope: 'M1' });
    await store.send('tower', { to: 'all', subject: 'broadcast', body: 'everyone' });
    await store.send('tower', { to: 'agent-build', subject: 'direct', body: 'you' });
    const workerInbox = await store.readInbox('agent-build', 20);
    expect(workerInbox.map((item) => item.subject).toSorted()).toEqual(['broadcast', 'direct']);
    const towerInbox = await store.readInbox('tower', 20);
    expect(towerInbox.map((item) => item.subject).toSorted()).toEqual(['broadcast', 'direct', 'report']);
    const report = towerInbox.find((item) => item.subject === 'report');
    expect(report).toMatchObject({ from: 'agent-build', to: 'tower', scope: 'M1', body: 'done' });
    const log = await activityLog(repo);
    expect(log).toContain('inbox.send');
    expect(log).toContain('ref=.tower/comms/inbox/');
  });

  it('files findings with the verbatim section layout and rejects bad types', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const store = testStore(repo);
    await store.init('session-a');
    await expect(
      store.fileFinding('tower', {
        type: 'other' as never,
        title: 'x',
        summary: 's',
        details: 'd',
        suggestedFix: 'f',
      }),
    ).rejects.toThrow('finding type must be one of bug | improve | vuln | idea');
    const rel = await store.fileFinding('tower', {
      type: 'bug',
      title: 'Broken thing',
      severity: 'high',
      summary: 'it broke',
      location: 'src/a.ts:3',
      details: 'evidence',
      suggestedFix: 'fix it',
    });
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(join(repo, rel), 'utf8');
    expect(content).toContain('# Finding: Broken thing');
    expect(content).toContain('**Severity**: high');
    expect(content).toContain('## Suggested Fix / Action');
    expect(content).toContain('Assigning to the control tower for routing.');
  });
});

describe('store: reviews and the merge gate', () => {
  async function repoWithBuildMission(): Promise<{ repo: string; store: TowerStore }> {
    const repo = await tmpRepo();
    await commitFile(repo, 'src/api/a.ts', 'export const a = 1;\n', 'initial');
    const store = testStore(repo);
    await store.init('session-a');
    await store.plan([{ title: 'API', scope: ['src/api/**'] }]);
    await store.updateMission('tower', 'M1', { status: 'active', owner: 'agent-build' });
    await store.registerAgent({
      name: 'agent-build',
      agentId: 'subagent-1',
      sessionId: 'session-a',
      kind: 'worker',
      missionId: 'M1',
      worktree: 'wt-1',
      branch: 'feat/api',
      spawnedAt: new Date().toISOString(),
    });
    await store.registerAgent({
      name: 'reviewer-a',
      agentId: 'subagent-2',
      sessionId: 'session-a',
      kind: 'reviewer',
      reviewTarget: 'feat/api',
      reviewMissionId: 'M1',
      spawnedAt: new Date().toISOString(),
    });
    await store.addWorktree('wt-1', 'feat/api', 'main');
    await writeFile(join(repo, '.tower', 'worktrees', 'wt-1', 'src', 'api', 'a.ts'), 'export const a = 2;\n');
    await git(join(repo, '.tower', 'worktrees', 'wt-1'), 'add', '-A');
    await git(join(repo, '.tower', 'worktrees', 'wt-1'), 'commit', '-m', 'work');
    return { repo, store };
  }

  it('rejects reviews from non-reviewers and bad verdicts; stamps rounds', async () => {
    const { store } = await repoWithBuildMission();
    await expect(
      store.submitReview('agent-build', {
        target: 'feat/api',
        status: 'clean',
        merge: 'merge',
        findings: 'none',
        decision: 'ok',
      }),
    ).rejects.toThrow('agent "agent-build" is not an assigned reviewer for "feat/api"');
    await expect(
      store.submitReview('reviewer-a', {
        target: 'feat/api',
        status: 'mostly-clean',
        merge: 'merge',
        findings: 'x',
        decision: 'x',
      }),
    ).rejects.toThrow('review status must be clean | p1-Nitems | p2-Nitems, got "mostly-clean"');
    const rel = await store.submitReview('reviewer-a', {
      target: 'feat/api',
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      checks: ['tests pass'],
      decision: 'lgtm',
    });
    const { readFile } = await import('node:fs/promises');
    expect((await store.load()).missions[0]?.worktree).toBe('wt-1');
    const review = await store.latestReview('feat/api');
    expect(review).toMatchObject({ reviewer: 'reviewer-a', round: 1, status: 'clean', mission: 'M1' });
    const content = await readFile(join((store as unknown as { repoRoot: string }).repoRoot, rel), 'utf8');
    expect(content).toContain('- [x] tests pass');
  });

  it('blocks merge without a review, on a stale tip, and merges after a clean review', async () => {
    const { repo, store } = await repoWithBuildMission();
    await expect(store.merge('feat/api')).rejects.toThrow(
      'merge blocked: feat/api has no review — assign a reviewer first',
    );
    await store.submitReview('reviewer-a', {
      target: 'feat/api',
      status: 'p1-2items',
      merge: 'fix-then-merge',
      findings: 'two issues',
      decision: 'fix first',
    });
    await expect(store.merge('feat/api')).rejects.toThrow(
      'merge blocked: latest review (round 1 by reviewer-a) is "p1-2items" — a clean round is required',
    );
    await store.submitReview('reviewer-a', {
      target: 'feat/api',
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'ok now',
    });
    const worktree = join(repo, '.tower', 'worktrees', 'wt-1');
    await writeFile(join(worktree, 'src', 'api', 'a.ts'), 'export const a = 3;\n');
    await git(worktree, 'add', '-A');
    await git(worktree, 'commit', '-m', 'more work');
    await expect(store.merge('feat/api')).rejects.toThrow(/merge blocked: feat\/api moved since the clean review/);
    await store.submitReview('reviewer-a', {
      target: 'feat/api',
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'ok again',
    });
    const result = await store.merge('feat/api');
    expect(result.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect((await store.load()).missions[0]?.status).toBe('merged');
    expect(await git(repo, 'log', '-1', '--format=%s', 'main')).toMatch(/Merge branch 'feat\/api'/);
    const log = await activityLog(repo);
    expect(log).toContain('merge.blocked');
    expect(log).toContain(' merge ');
  });

  it('blocks merge on out-of-scope changes and unmerged deps', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'src/api/a.ts', 'a\n', 'initial');
    const store = testStore(repo);
    await store.init('session-a');
    await store.plan([
      { title: 'API', scope: ['src/api/**'] },
      { title: 'Docs', scope: ['docs/**'], deps: ['M1'] },
    ]);
    await store.addWorktree('wt-1', 'feat/api', 'main');
    const worktree = join(repo, '.tower', 'worktrees', 'wt-1');
    await writeFile(join(worktree, 'src', 'api', 'a.ts'), 'b\n');
    await writeFile(join(worktree, 'escape.txt'), 'out\n');
    await git(worktree, 'add', '-A');
    await git(worktree, 'commit', '-m', 'work');
    await store.submitReview('tower', {
      target: 'feat/api',
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'ok',
    });
    await expect(store.merge('feat/api')).rejects.toThrow(
      /merge blocked: feat\/api changed files outside mission M1 scope \(src\/api\/\*\*\): escape\.txt/,
    );
    await git(worktree, 'rm', 'escape.txt');
    await git(worktree, 'commit', '-m', 'drop escape');
    await store.submitReview('tower', {
      target: 'feat/api',
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'ok',
    });
    await expect(store.merge('feat/none')).rejects.toThrow(
      'no tower mission owns branch "feat/none"',
    );
    await expect(store.merge('feat/docs')).rejects.toThrow(
      'merge blocked: dependencies not merged yet (M1) — merge in Dependency Flow order',
    );
    await store.addWorktree('wt-2', 'feat/docs', 'main');
  });

  it('closes a clean survey with a zero-diff noop merge and blocks a dirty survey', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a\n', 'initial');
    const store = testStore(repo);
    await store.init('session-a');
    await store.plan([{ title: 'Survey', scope: ['src/**'], kind: 'survey' }]);
    await store.addWorktree('wt-1', 'feat/survey', 'main');
    const result = await store.merge('feat/survey');
    expect(result.noop).toBe(true);
    expect((await store.load()).missions[0]?.status).toBe('merged');
    const log = await activityLog(repo);
    expect(log).toContain('merge.noop');
  });

  it('blocks merge when the checkout is not on the recorded base', async () => {
    const { repo, store } = await repoWithBuildMission();
    await store.submitReview('reviewer-a', {
      target: 'feat/api',
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'ok',
    });
    await git(repo, 'checkout', '-b', 'elsewhere');
    await expect(store.merge('feat/api')).rejects.toThrow(
      'merge blocked: the main checkout is on "elsewhere", not the recorded base "main" — switch it back (`git checkout main`) and retry; nothing was merged',
    );
  });
});

describe('store: addWorktree and teardown', () => {
  it('snapshots base WIP into the worker branch and records the spawn base', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a\n', 'initial');
    const store = testStore(repo);
    await store.init('session-a');
    await store.plan([{ title: 'API', scope: ['src/api/**'] }]);
    await writeFile(join(repo, 'wip.txt'), 'wip\n');
    const added = await store.addWorktree('wt-1', 'feat/api', 'main');
    expect(added.spawnBase).toBeDefined();
    expect(await git(repo, 'status', '--porcelain')).toBe('?? wip.txt');
    expect(await git(repo, 'log', '-1', '--format=%s', 'feat/api')).toBe(
      'tower: snapshot of uncommitted base checkout changes (worktree wt-1)',
    );
    expect(await git(repo, 'show', '--name-only', '--format=', added.spawnBase!)).toContain('wip.txt');
  });

  it('refuses to build on a branch that appeared in git after planning without tower ownership', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a\n', 'initial');
    const store = testStore(repo);
    await store.init('session-a');
    await store.plan([{ title: 'API', scope: ['src/api/**'] }]);
    await git(repo, 'branch', 'feat/api');
    await expect(store.addWorktree('wt-1', 'feat/api', 'main')).rejects.toThrow(
      'branch "feat/api" exists in git but is not owned by any tower mission (it appeared after planning)',
    );
  });

  it('keeps dirty worktrees by default and removes them with force', async () => {
    const repo = await tmpRepo();
    await commitFile(repo, 'a.txt', 'a\n', 'initial');
    const store = testStore(repo);
    await store.init('session-a');
    await store.plan([{ title: 'API', scope: ['src/api/**'] }]);
    await store.addWorktree('wt-1', 'feat/api', 'main');
    const worktree = join(repo, '.tower', 'worktrees', 'wt-1');
    await writeFile(join(worktree, 'dirty.txt'), 'dirty\n');
    const first = await store.teardown();
    expect(first.join('\n')).toContain('kept .tower/worktrees/wt-1 (uncommitted changes');
    const second = await store.teardown({ force: true });
    expect(second.join('\n')).toContain('removed .tower/worktrees/wt-1');
    const third = await store.teardown({ force: true });
    expect(third.join('\n')).toContain('already removed .tower/worktrees/wt-1');
  });
});

describe('rate limiter', () => {
  it('gates spawns on budget and pause, recovers on success, resets', () => {
    let now = 1_000_000;
    const limiter = createTowerRateLimiter(() => now);
    expect(limiter.snapshot()).toMatchObject({ budget: 16, inflight: 0, blockedUntil: null });
    limiter.reportRateLimited();
    const denied = limiter.acquire();
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).toContain('provider rate limit hit — new tower spawns paused for ~60s');
    }
    now += 61_000;
    const ok = limiter.acquire();
    expect(ok.ok).toBe(true);
    expect(limiter.snapshot().inflight).toBe(1);
    limiter.release();
    expect(limiter.snapshot().inflight).toBe(0);
    limiter.reportSuccess();
    expect(limiter.snapshot().blockedUntil).toBeNull();
    limiter.reset();
    expect(limiter.snapshot()).toMatchObject({ budget: 16, inflight: 0, blockedUntil: null });
  });

  it('shrinks capacity on rate limit reports while agents are inflight', () => {
    let now = 0;
    const limiter = createTowerRateLimiter(() => now);
    for (let i = 0; i < 4; i++) limiter.acquire();
    limiter.reportRateLimited();
    expect(limiter.budget()).toBe(3);
    now = 1_000;
    limiter.reportRateLimited();
    expect(limiter.budget()).toBe(3);
    now = 2_000;
    limiter.reportRateLimited();
    expect(limiter.budget()).toBe(2);
    now = 182_000;
    limiter.reportSuccess();
    expect(limiter.budget()).toBe(3);
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


interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type ScriptStep =
  | { text: string }
  | { toolCall: { name: string; arguments: string } }
  | { throw: unknown };

type LlmScript = (call: LlmCall) => ScriptStep;

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

const fastModel: SpawnModelEntry = {
  name: 'fast',
  description: 'Fast test model',
  model: { provider: 'test', model: 'fast-model', capability: UNKNOWN_CAPABILITY },
};

let queue: ScriptStep[] = [];

function routingScript(call: LlmCall): ScriptStep {
  if (queue.length > 0) return queue.shift()!;
  const last = call.messages.at(-1);
  if (last !== undefined && last.role === 'tool') return { text: 'done' };
  const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
  if (text.includes('a tower worker agent in a multi-agent workspace')) return { text: 'worker done' };
  if (text.includes('a tower reviewer agent in a multi-agent workspace')) return { text: 'reviewer done' };
  if (text.startsWith('TOWER:')) return { toolCall: { name: 'TowerInit', arguments: text.slice('TOWER:'.length) } };
  if (text.startsWith('PLAN:')) return { toolCall: { name: 'TowerPlan', arguments: text.slice('PLAN:'.length) } };
  if (text.startsWith('SPAWN:')) return { toolCall: { name: 'TowerSpawn', arguments: text.slice('SPAWN:'.length) } };
  if (text.startsWith('SEND:')) return { toolCall: { name: 'TowerSend', arguments: text.slice('SEND:'.length) } };
  if (text.startsWith('MISSION:')) return { toolCall: { name: 'TowerMission', arguments: text.slice('MISSION:'.length) } };
  if (text.startsWith('RESUME:')) return { toolCall: { name: 'Agent', arguments: text.slice('RESUME:'.length) } };
  if (text === 'TODO') return { toolCall: { name: 'TodoList', arguments: '{}' } };
  if (text === 'INBOX') return { toolCall: { name: 'TowerInbox', arguments: '{}' } };
  if (text === 'STATUS') return { toolCall: { name: 'TowerStatus', arguments: '{}' } };
  if (text === 'READ') return { toolCall: { name: 'Read', arguments: '{}' } };
  return { text: 'main done' };
}

function createMockRequester(script: LlmScript): { requester: LlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    calls,
    requester: {
      generate: async (_config, content, { onEvent }) => {
        const call: LlmCall = {
          systemPrompt: content.systemPrompt,
          messages: content.messages,
          tools: content.tools ?? [],
        };
        calls.push(call);
        const out = script(call);
        if ('throw' in out) throw out.throw;
        if ('toolCall' in out) {
          onEvent?.({
            type: 'llm.streaming.part',
            part: {
              type: 'function',
              id: `call-${calls.length}`,
              name: out.toolCall.name,
              arguments: out.toolCall.arguments,
            },
          });
        } else {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: out.text } });
        }
        onEvent?.({
          type: 'llm.streaming.usage',
          usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
        });
        onEvent?.({ type: 'llm.done' });
      },
    },
  };
}

function bindTestLlm(requester: LlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setConfig({ model });
      agent.setRequester(requester);
    },
  });
}

const executed: string[] = [];

function bindTestTools(): FeatureSpec {
  return createFeature('test-tools', {
    agent() {
      const tool = (name: string) => ({
        name,
        description: `${name} tool`,
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          executed.push(name);
          return { content: [{ type: 'text' as const, text: `${name} executed` }] };
        },
      });
      useAgentTools(tool('Read'), tool('Write'), tool('Edit'), tool('TodoList'));
    },
  });
}

async function testStores(): Promise<SessionStores> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return openSessionStores(tree, openBlobs(backend.blobs));
}

function waitTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

interface TowerTestEnv {
  readonly app: Awaited<ReturnType<typeof createHarness>>;
  readonly stores: SessionStores;
  readonly session: Awaited<ReturnType<Awaited<ReturnType<typeof createHarness>>['create']>>;
  readonly main: AgentHandle;
  readonly calls: LlmCall[];
  readonly workDir: string;
  readonly host: OsHost;
  runTurn(text: string, agent?: AgentHandle): Promise<void>;
  dispose(): Promise<void>;
}

async function startApp(opts?: {
  script?: LlmScript;
  workDir?: string;
  available?: boolean | (() => boolean);
  models?: readonly SpawnModelEntry[];
  withProfiles?: boolean;
  withPlan?: boolean;
  withSpawn?: boolean;
  withTask?: boolean;
  withHost?: boolean;
}): Promise<TowerTestEnv> {
  const stores = await testStores();
  const workDir = opts?.workDir ?? (await mkdtemp(join(tmpdir(), 'tower-work-')));
  const homeDir = await mkdtemp(join(tmpdir(), 'tower-home-'));
  tmpDirs.push(workDir, homeDir);
  const { requester, calls } = createMockRequester(opts?.script ?? routingScript);
  const host = createNodeOsHost();
  const tower = createTower({
    workDir,
    host: opts?.withHost === false ? undefined : host,
    available: opts?.available ?? (() => true),
    models: opts?.models,
  });
  const features: FeatureSpec[] = [tower, bindTestTools(), bindTestLlm(requester)];
  if (opts?.withSpawn !== false) features.unshift(createSpawn({ workDir, host }));
  if (opts?.withTask !== false) features.unshift(createTask());
  if (opts?.withProfiles === true) features.unshift(createProfiles({ workDir, host, home: homeDir }));
  if (opts?.withPlan === true) features.unshift(createPlan(), interaction);
  const app = createHarness({ features });
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  const runTurn = async (text: string, agent: AgentHandle = main): Promise<void> => {
    const done = waitTurnDone(agent);
    agent.submit(createUserMessage(text));
    await done;
    await stores.flush();
  };
  const dispose = async (): Promise<void> => {
    await app.disposeAsync();
    await stores.dispose();
  };
  return { app, stores, session, main, calls, workDir, host, runTurn, dispose };
}

function toolResultTexts(stores: SessionStores, agentId = MAIN_AGENT_ID): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolResultIsErrors(stores: SessionStores, agentId = MAIN_AGENT_ID): boolean[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => (entry.meta as ToolMeta | undefined)?.isError === true);
}

function userTexts(stores: SessionStores, agentId = MAIN_AGENT_ID): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'user')
    .map((entry) => extractText(entry.message));
}

function towerReminders(stores: SessionStores, agentId = MAIN_AGENT_ID): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.meta?.source === 'reminder' && entry.meta?.key === 'tower-mode')
    .map((entry) => extractText(entry.message));
}

async function waitUntil(condition: () => boolean | Promise<boolean>): Promise<void> {
  await vi.waitFor(async () => {
    expect(await condition()).toBe(true);
  });
}

afterEach(() => {
  queue = [];
  executed.length = 0;
});

describe('feature gating', () => {
  it('registers no tower tools and reports experiment-off when unavailable', async () => {
    const env = await startApp({ available: false });
    try {
      const face = env.main.resolve(TowerRef);
      expect(face.isActive()).toBe(false);
      expect(await face.enter()).toEqual({ entered: false, reason: 'experiment-off' });
      await env.runTurn('hello');
      const names = env.calls[0]?.tools.map((tool) => tool.name) ?? [];
      expect(names.some((name) => name.startsWith('Tower'))).toBe(false);
      queue = [{ toolCall: { name: 'TodoList', arguments: '{}' } }, { text: 'done' }];
      await env.runTurn('TODO');
      expect(executed).toContain('TodoList');
    } finally {
      await env.dispose();
    }
  });

  it('reports feature-not-assembled when no host is injected and keeps tools unregistered', async () => {
    const env = await startApp({ withHost: false });
    try {
      const face = env.main.resolve(TowerRef);
      expect(await face.enter()).toEqual({ entered: false, reason: 'feature-not-assembled' });
      await env.runTurn('hello');
      const names = env.calls[0]?.tools.map((tool) => tool.name) ?? [];
      expect(names.some((name) => name.startsWith('Tower'))).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  it('reads the default availability from the experimental env flag', async () => {
    process.env['KIMI_CODE_EXPERIMENTAL_TOWER'] = '1';
    const repo = await tmpRepo('tower-env-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const env = await startApp({ workDir: repo, available: undefined });
    try {
      const face = env.main.resolve(TowerRef);
      expect(await face.enter()).toEqual({ entered: true });
      expect(face.isActive()).toBe(true);
      await env.runTurn('hello');
      const names = env.calls[0]?.tools.map((tool) => tool.name) ?? [];
      expect(names).toContain('TowerInit');
      expect(names).toContain('TowerSpawn');
      expect(names).toContain('TowerStatus');
    } finally {
      await env.dispose();
    }
  });

  it('reports not-main-agent on a subagent and stays inert', async () => {
    const env = await startApp();
    try {
      const sub = await env.session.create({ agentId: 'sub-1', systemPrompt: 'sub' });
      const face = sub.resolve(TowerRef);
      expect(face.isActive()).toBe(false);
      expect(await face.enter()).toEqual({ entered: false, reason: 'not-main-agent' });
    } finally {
      await env.dispose();
    }
  });
});

describe('enter and exit', () => {
  it('toggles the durable mode state and releases workspace ownership on exit', async () => {
    const repo = await tmpRepo('tower-enter-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const store = testStore(repo);
    await store.init('sess');
    const env = await startApp({ workDir: repo });
    try {
      const face = env.main.resolve(TowerRef);
      expect(await face.enter()).toEqual({ entered: true });
      expect(face.isActive()).toBe(true);
      expect(face.state.value).toMatchObject({ active: true, owner: 'sess' });
      expect(await face.enter()).toEqual({ entered: true });
      await face.exit();
      expect(face.isActive()).toBe(false);
      expect(face.state.value.active).toBe(false);
      await face.exit();
      expect((await store.load()).sessionId).toBeUndefined();
    } finally {
      await env.dispose();
    }
  });

  it('enter(base) creates the branch, switches to it, and initializes the workspace', async () => {
    const repo = await tmpRepo('tower-enter-base-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const env = await startApp({ workDir: repo });
    try {
      const face = env.main.resolve(TowerRef);
      expect(await face.enter('develop')).toEqual({ entered: true });
      expect(face.requestedBase()).toBe('develop');
      expect(await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
      const state = await testStore(repo).load();
      expect(state.base).toBe('develop');
      expect(state.sessionId).toBe('sess');
      expect(await face.enter('develop')).toEqual({ entered: true });
    } finally {
      await env.dispose();
    }
  });

  it('enter(base) on a dirty checkout commits the changes onto the new base', async () => {
    const repo = await tmpRepo('tower-enter-dirty-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    await writeFile(join(repo, 'wip.txt'), 'wip\n');
    const env = await startApp({ workDir: repo });
    try {
      const face = env.main.resolve(TowerRef);
      expect(await face.enter('wipbase')).toEqual({ entered: true });
      expect(await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wipbase');
      expect(await git(repo, 'status', '--porcelain')).toBe('');
      expect(await git(repo, 'log', '-1', '--format=%s')).toBe(
        'tower: snapshot of uncommitted base checkout changes (base wipbase)',
      );
    } finally {
      await env.dispose();
    }
  });

  it('enter(base) refuses to rebase while missions are open', async () => {
    const repo = await tmpRepo('tower-enter-open-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const store = testStore(repo);
    await store.init('sess', 'main');
    await store.plan([{ title: 'API', scope: ['src/api/**'] }]);
    const env = await startApp({ workDir: repo });
    try {
      const face = env.main.resolve(TowerRef);
      await expect(face.enter('develop')).rejects.toThrow(
        'tower workspace already records base "main" with 1 open mission(s) (M1) — merge or abandon them (or /tower teardown) before switching the tower to base "develop"',
      );
      expect(face.isActive()).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  it('refuses to enter while another live session owns the workspace, adopts once it is gone', async () => {
    const repo = await tmpRepo('tower-owner-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    await testStore(repo).init();
    const homeDir = await mkdtemp(join(tmpdir(), 'tower-home-'));
    tmpDirs.push(homeDir);
    const { requester } = createMockRequester(routingScript);
    const host = createNodeOsHost();
    const tower = createTower({ workDir: repo, host, available: () => true });
    const app = createHarness({ features: [tower, bindTestTools(), bindTestLlm(requester)] });
    await app.ready();
    const storesA = await testStores();
    const storesB = await testStores();
    try {
      const sessionA = await app.create({ sessionId: 'sess-a', stores: storesA });
      const mainA = await sessionA.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'a' });
      const sessionB = await app.create({ sessionId: 'sess-b', stores: storesB });
      const mainB = await sessionB.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'b' });
      expect(await mainA.resolve(TowerRef).enter()).toEqual({ entered: true });
      expect(await mainB.resolve(TowerRef).enter()).toEqual({
        entered: false,
        reason: 'owned-by-live-session',
        owner: 'sess-a',
      });
      await app.close('sess-a');
      expect(await mainB.resolve(TowerRef).enter()).toEqual({ entered: true });
      expect((await testStore(repo).load()).sessionId).toBe('sess-b');
    } finally {
      await app.disposeAsync();
      await storesA.dispose();
      await storesB.dispose();
    }
  });
});

describe('guards', () => {
  it('denies TodoList while tower mode is active with the verbatim message', async () => {
    const repo = await tmpRepo('tower-guard-todo-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const env = await startApp({ workDir: repo });
    try {
      await env.main.resolve(TowerRef).enter();
      await env.runTurn('TODO');
      expect(executed).not.toContain('TodoList');
      expect(toolResultTexts(env.stores).at(-1)).toBe(
        'TodoList is not available while tower mode is active — mission state lives in the tower protocol (TowerPlan/TowerMission/TowerStatus, MISSIONS.md), and todo semantics would serialize the fleet. Spawn every dependency-unblocked mission now, then end your turn: worker completions wake you.',
      );
    } finally {
      await env.dispose();
    }
  });

  it('denies a foreground Agent resume of a roster agent and allows background or unknown resumes', async () => {
    const repo = await tmpRepo('tower-guard-resume-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const store = testStore(repo);
    await store.init('sess');
    await store.registerAgent({
      name: 'agent-build',
      agentId: 'subagent-1',
      sessionId: 'sess',
      kind: 'worker',
      spawnedAt: new Date().toISOString(),
    });
    const env = await startApp({ workDir: repo });
    try {
      await env.main.resolve(TowerRef).enter();
      await env.runTurn('RESUME:{"resume":"subagent-1","prompt":"go"}');
      expect(toolResultTexts(env.stores).at(-1)).toBe(
        'Resuming tower agent "agent-build" in the foreground would freeze the tower until it finishes — pass run_in_background=true instead; its completion (and any inbox traffic) will wake you.',
      );
      await env.runTurn('RESUME:{"resume":"subagent-1","run_in_background":true,"prompt":"go"}');
      const background = toolResultTexts(env.stores).at(-1) ?? '';
      expect(background).not.toContain('would freeze the tower');
      await env.runTurn('RESUME:{"resume":"subagent-9","prompt":"go"}');
      const unknown = toolResultTexts(env.stores).at(-1) ?? '';
      expect(unknown).not.toContain('would freeze the tower');
    } finally {
      await env.dispose();
    }
  });
});

describe('worker spawn flow', () => {
  it('spawns a worker, guards its writes to the worktree, and tracks completion', async () => {
    const repo = await tmpRepo('tower-spawn-');
    await commitFile(repo, 'src/api/a.ts', 'a\n', 'initial');
    const worktreeAbs = join(repo, '.tower', 'worktrees', 'wt-1');
    const script: LlmScript = (call) => {
      const last = call.messages.at(-1);
      const text = lastUserText(call.messages);
      if (text.includes('a tower worker agent in a multi-agent workspace')) {
        if (last?.role === 'tool') {
          const denied = toolResultTextsFromMessages(call.messages).some((t) =>
            t.includes('may only write inside their own worktree'),
          );
          if (!denied) {
            return { toolCall: { name: 'Write', arguments: JSON.stringify({ file_path: join(repo, 'escape.ts') }) } };
          }
          return { text: 'worker done' };
        }
        return { toolCall: { name: 'Write', arguments: JSON.stringify({ file_path: join(repo, 'escape.ts') }) } };
      }
      if (last !== undefined && last.role === 'tool') return { text: 'done' };
      if (text.startsWith('TOWER:')) return { toolCall: { name: 'TowerInit', arguments: text.slice(6) } };
      if (text.startsWith('PLAN:')) return { toolCall: { name: 'TowerPlan', arguments: text.slice(5) } };
      if (text.startsWith('SPAWN:')) return { toolCall: { name: 'TowerSpawn', arguments: text.slice(6) } };
      return { text: 'main done' };
    };
    const env = await startApp({ workDir: repo, script, models: [fastModel] });
    try {
      await env.main.resolve(TowerRef).enter();
      await env.runTurn('TOWER:{}');
      expect(toolResultTexts(env.stores).at(-1)).toContain('tower workspace initialized');
      await env.runTurn('PLAN:{"missions":[{"title":"Build API","scope":["src/api/**"]}]}');
      expect(toolResultTexts(env.stores).at(-1)).toContain('| M1 | Build API | build | feat/build-api | wt-1 | src/api/** |');
      await env.runTurn('SPAWN:{"name":"agent-build","kind":"worker","mission_id":"M1"}');
      const ack = toolResultTexts(env.stores).at(-1) ?? '';
      expect(ack).toContain('name: agent-build');
      expect(ack).toContain('kind: worker');
      expect(ack).toContain('status: running');
      expect(ack).toContain('model: fast');
      expect(ack).toContain(`worktree: ${worktreeAbs}`);
      const agentId = /agent_id: (\S+)/.exec(ack)?.[1] ?? '';
      expect(agentId).not.toBe('');
      await waitUntil(async () => {
        const texts = userTexts(env.stores);
        return texts.some(
          (t) => t.includes('[async tool completed] TowerSpawn') && t.includes('status: completed'),
        );
      });
      await env.stores.flush();
      const completion = userTexts(env.stores).find((t) =>
        t.includes('[async tool completed] TowerSpawn'),
      );
      expect(completion).toContain('worker done');
      const store = testStore(repo);
      const state = await store.load();
      const entry = store.resolveAgent(state, agentId);
      expect(entry).toMatchObject({
        name: 'agent-build',
        kind: 'worker',
        missionId: 'M1',
        worktree: 'wt-1',
        branch: 'feat/build-api',
        sessionId: 'sess',
      });
      expect(entry?.diedAt).toBeUndefined();
      expect(state.missions[0]).toMatchObject({ status: 'active', owner: 'agent-build' });
      const workerResults = toolResultTexts(env.stores, agentId);
      expect(
        workerResults.some((t) =>
          t.includes(
            `tower workers may only write inside their own worktree (${worktreeAbs}) — denied: ${join(repo, 'escape.ts')}. Out-of-scope changes are not yours to make: file them with TowerFinding or ask the tower via TowerSend.`,
          ),
        ),
      ).toBe(true);
      expect(executed).not.toContain('Write');
      const log = await activityLog(repo);
      expect(log).toContain(' spawn ');
      expect(log).toContain('model=fast');
    } finally {
      await env.dispose();
    }
  });

  it('clears the died mark when a dead tower agent is resumed via the Agent tool', async () => {
    const repo = await tmpRepo('tower-revive-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const script: LlmScript = (call) => {
      const last = call.messages.at(-1);
      const text = lastUserText(call.messages);
      if (last !== undefined && last.role === 'tool') return { text: 'done' };
      if (text.startsWith('AGENT:')) return { toolCall: { name: 'Agent', arguments: text.slice(6) } };
      return { text: 'child done' };
    };
    const env = await startApp({ workDir: repo, script, withProfiles: true });
    try {
      const store = testStore(repo);
      await store.init('sess');
      await env.runTurn('AGENT:{"prompt":"hello","description":"kid"}');
      const spawned = toolResultTexts(env.stores).at(-1) ?? '';
      const agentId = /agent_id: (\S+)/.exec(spawned)?.[1] ?? '';
      expect(agentId).not.toBe('');
      await store.registerAgent({
        name: 'agent-kid',
        agentId,
        sessionId: 'sess',
        kind: 'worker',
        spawnedAt: new Date().toISOString(),
      });
      await store.markAgentDied(agentId, 'failed', 'boom');
      expect((await store.load()).roster.agents[0]?.diedAt).toBeDefined();
      await env.runTurn(
        `AGENT:{"prompt":"again","description":"kid","resume":"${agentId}","run_in_background":true}`,
      );
      await waitUntil(async () => (await store.load()).roster.agents[0]?.diedAt === undefined);
      expect(await activityLog(repo)).toContain(' revived ');
    } finally {
      await env.dispose();
    }
  });

  it('refuses duplicate and reserved names before any side effects', async () => {
    const repo = await tmpRepo('tower-spawn-dup-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const env = await startApp({ workDir: repo });
    try {
      const store = testStore(repo);
      await store.init('sess');
      await store.registerAgent({
        name: 'agent-build',
        agentId: 'subagent-1',
        sessionId: 'sess',
        kind: 'worker',
        spawnedAt: new Date().toISOString(),
      });
      await env.main.resolve(TowerRef).enter();
      await env.runTurn('SPAWN:{"name":"tower","kind":"reviewer","review_target":"feat/x"}');
      expect(toolResultTexts(env.stores).at(-1)).toBe(
        'tower agent name "tower" is reserved by the tower protocol — pick a different name',
      );
      await env.runTurn('SPAWN:{"name":"agent-build","kind":"reviewer","review_target":"feat/x"}');
      expect(toolResultTexts(env.stores).at(-1)).toContain(
        'tower agent "agent-build" is already registered (agent_id: subagent-1, kind: worker)',
      );
      await env.runTurn('SPAWN:{"name":"agent-fresh","kind":"worker"}');
      expect(toolResultTexts(env.stores).at(-1)).toBe(
        'invalid TowerSpawn arguments: {"name":"agent-fresh","kind":"worker"}',
      );
      expect(toolResultIsErrors(env.stores)).toEqual([true, true, true]);
    } finally {
      await env.dispose();
    }
  });

  it('refuses TowerSpawn while tower mode is inactive', async () => {
    const repo = await tmpRepo('tower-spawn-inactive-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const env = await startApp({ workDir: repo });
    try {
      await env.runTurn('SPAWN:{"name":"agent-build","kind":"worker","mission_id":"M1"}');
      expect(toolResultTexts(env.stores).at(-1)).toBe(
        'tower mode is not active — only the user can enable it (with /tower on), never the agent. Ask the user to turn tower mode on, then drive the tower protocol.',
      );
      expect(toolResultIsErrors(env.stores).at(-1)).toBe(true);
    } finally {
      await env.dispose();
    }
  });
});

describe('inbox wake', () => {
  it('wakes the main agent once when a worker messages the tower, with the injection origin', async () => {
    const repo = await tmpRepo('tower-wake-');
    await commitFile(repo, 'src/api/a.ts', 'a\n', 'initial');
    const script: LlmScript = (call) => {
      const last = call.messages.at(-1);
      const text = lastUserText(call.messages);
      if (text.includes('a tower worker agent in a multi-agent workspace')) {
        if (last?.role === 'tool') return { text: 'worker done' };
        return {
          toolCall: {
            name: 'TowerSend',
            arguments: JSON.stringify({ to: 'tower', subject: 'hello', body: 'ping' }),
          },
        };
      }
      if (last !== undefined && last.role === 'tool') return { text: 'done' };
      if (text.startsWith('TOWER:')) return { toolCall: { name: 'TowerInit', arguments: text.slice(6) } };
      if (text.startsWith('PLAN:')) return { toolCall: { name: 'TowerPlan', arguments: text.slice(5) } };
      if (text.startsWith('SPAWN:')) return { toolCall: { name: 'TowerSpawn', arguments: text.slice(6) } };
      return { text: 'main done' };
    };
    const env = await startApp({ workDir: repo, script });
    try {
      await env.main.resolve(TowerRef).enter();
      await env.runTurn('TOWER:{}');
      await env.runTurn('PLAN:{"missions":[{"title":"Build API","scope":["src/api/**"]}]}');
      await env.runTurn('SPAWN:{"name":"agent-build","kind":"worker","mission_id":"M1"}');
      await waitUntil(() =>
        userTexts(env.stores).some((t) =>
          t.includes('1 new tower inbox message — latest from agent-build: "hello". Read and route with TowerInbox.'),
        ),
      );
      await env.stores.flush();
      const history = env.stores.get(MAIN_AGENT_ID)?.getState().history ?? [];
      const wake = history.find(
        (entry) =>
          entry.message.role === 'user' &&
          extractText(entry.message).includes('1 new tower inbox message'),
      );
      expect(wake?.meta?.['origin']).toEqual({ kind: 'injection', variant: TOWER_INBOX_WAKE_VARIANT });
      const workerSendResult = toolResultTexts(env.stores, 'subagent-unknown').length;
      expect(workerSendResult).toBe(0);
    } finally {
      await env.dispose();
    }
  });

  it('stays silent when the tower itself sends', async () => {
    const repo = await tmpRepo('tower-wake-self-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const env = await startApp({ workDir: repo });
    try {
      await env.main.resolve(TowerRef).enter();
      await env.runTurn('TOWER:{}');
      await env.runTurn('SEND:{"to":"all","subject":"heads-up","body":"fyi"}');
      expect(toolResultTexts(env.stores).at(-1)).toContain('message sent to all');
      const before = userTexts(env.stores).length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await env.stores.flush();
      const after = userTexts(env.stores);
      expect(after.length).toBe(before);
      expect(after.some((t) => t.includes('new tower inbox message'))).toBe(false);
    } finally {
      await env.dispose();
    }
  });
});

describe('mode mutex', () => {
  it('tower enter exits plan mode and plan enter exits tower mode', async () => {
    const repo = await tmpRepo('tower-mutex-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const env = await startApp({ workDir: repo, withPlan: true });
    try {
      const tower = env.main.resolve(TowerRef);
      const plan = env.main.resolve(PlanRef);
      await plan.enter();
      expect(plan.state.value.active).toBe(true);
      expect(await tower.enter()).toEqual({ entered: true });
      await waitUntil(() => !plan.state.value.active);
      expect(tower.isActive()).toBe(true);
      await plan.enter();
      await waitUntil(() => !tower.isActive());
      expect(plan.state.value.active).toBe(true);
    } finally {
      await env.dispose();
    }
  });
});

describe('worker profile', () => {
  it('is visible through the profile catalog with the feature source id', async () => {
    const repo = await tmpRepo('tower-profile-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const env = await startApp({ workDir: repo, withProfiles: true });
    try {
      const catalog = env.app.resolve(ProfileCatalogRef);
      await catalog.ready;
      await waitUntil(() => catalog.get(TOWER_WORKER_PROFILE) !== undefined);
      const profile = catalog.get(TOWER_WORKER_PROFILE);
      expect(profile).toBeDefined();
      expect(profile?.tools).toHaveLength(29);
      expect(profile?.subagents).toEqual(['explore', 'plan']);
      expect(catalog.inspect(TOWER_WORKER_PROFILE)?.sourceId).toBe('feature:tower');
      expect(TOWER_WORKER_PROFILE_DEF.description).toContain('Tower worker/reviewer agent');
    } finally {
      await env.dispose();
    }
  });
});

function toolResultTextsFromMessages(messages: readonly Message[]): string[] {
  return messages.filter((m) => m.role === 'tool').map((m) => extractText(m));
}

function lastUserText(messages: readonly Message[]): string {
  const last = messages.findLast((m) => m.role === 'user');
  return last === undefined ? '' : extractText(last);
}



function classifyReminder(text: string): 'full' | 'sparse' | 'exit' | 'unknown' {
  if (text === systemReminderText(TOWER_MODE_FULL_REMINDER)) return 'full';
  if (text === systemReminderText(TOWER_MODE_SPARSE_REMINDER)) return 'sparse';
  if (text === systemReminderText(TOWER_MODE_EXIT_REMINDER)) return 'exit';
  return 'unknown';
}

describe('mode injection', () => {
  it('injects full on activation, sparse at the short window, and exit once', async () => {
    const repo = await tmpRepo('tower-inject-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const env = await startApp({ workDir: repo });
    try {
      const face = env.main.resolve(TowerRef);
      expect(towerReminders(env.stores)).toEqual([]);
      await face.enter();
      queue = [
        { toolCall: { name: 'Read', arguments: '{}' } },
        { toolCall: { name: 'Read', arguments: '{}' } },
        { toolCall: { name: 'Read', arguments: '{}' } },
        { toolCall: { name: 'Read', arguments: '{}' } },
        { toolCall: { name: 'Read', arguments: '{}' } },
        { toolCall: { name: 'Read', arguments: '{}' } },
        { toolCall: { name: 'Read', arguments: '{}' } },
        { text: 'done' },
      ];
      await env.runTurn('READ');
      expect(towerReminders(env.stores).map(classifyReminder)).toEqual([
        'full',
        'sparse',
        'sparse',
      ]);
      await face.exit();
      queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'done' }];
      await env.runTurn('again');
      expect(towerReminders(env.stores).map(classifyReminder)).toEqual([
        'full',
        'sparse',
        'sparse',
        'exit',
      ]);
      queue = [{ text: 'done' }];
      await env.runTurn('once more');
      expect(towerReminders(env.stores).map(classifyReminder)).toEqual([
        'full',
        'sparse',
        'sparse',
        'exit',
      ]);
    } finally {
      await env.dispose();
    }
  });

  it('refreshes the full reminder when a user message follows an assistant turn', async () => {
    const repo = await tmpRepo('tower-inject-user-');
    await commitFile(repo, 'a.txt', 'a', 'initial');
    const env = await startApp({ workDir: repo });
    try {
      const face = env.main.resolve(TowerRef);
      await face.enter();
      queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'first' }];
      await env.runTurn('one');
      queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'second' }];
      await env.runTurn('two');
      expect(towerReminders(env.stores).map(classifyReminder)).toEqual(['full', 'full']);
    } finally {
      await env.dispose();
    }
  });
});

describe('mode injection windows', () => {
  const assistant = (text: string): HistoryMessage => ({
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
  });
  const user = (text: string): HistoryMessage => ({
    message: createHistoryMessageBuilder().plain(text).userMessage(),
  });
  const fullReminder = (): HistoryMessage => ({
    message: createHistoryMessageBuilder().systemReminder(TOWER_MODE_FULL_REMINDER).userMessage(),
    meta: { source: 'reminder', key: 'tower-mode' },
  });

  function drive(msgs: HistoryMessage[]): string[] {
    const sent: string[] = [];
    const agent = {
      remind: (message: unknown) => {
        sent.push(classifyReminder(extractText((message as HistoryMessage['message']))));
        return undefined;
      },
    } as unknown as AgentCommands;
    const hook = createTowerInjection({ agent, isActive: () => true, history: msgs });
    void hook({ messages: msgs, config: undefined as never, tools: [], systemPrompt: undefined });
    return sent;
  }

  it('skips reinjection below the threshold and fires sparse and full at the windows', () => {
    const base = [user('go'), fullReminder()];
    expect(drive([...base, assistant('one')])).toEqual([]);
    expect(drive([...base, assistant('one'), assistant('two')])).toEqual(['sparse']);
    expect(
      drive([
        ...base,
        assistant('one'),
        assistant('two'),
        assistant('three'),
        assistant('four'),
        assistant('five'),
      ]),
    ).toEqual(['full']);
    expect(drive([...base, assistant('one'), user('next')])).toEqual(['full']);
    expect(drive([...base, user('first objective')])).toEqual([]);
  });
});
