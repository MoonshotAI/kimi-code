import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TowerProtocolError, TowerStore, parseFrontmatter } from '../../../src/features/tower/protocol';
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
}): Promise<TowerMission> {
  const missions = await store.plan([
    { title: input.title, scope: [input.scope], deps: input.deps },
  ]);
  const mission = missions[0]!;
  const state = await store.load();
  await store.addWorktree(mission.worktree, mission.branch, state.base);
  await commitFile(worktreeOf(mission), input.file, input.content, `work on ${mission.id}`);
  return mission;
}

function worktreeOf(mission: TowerMission): string {
  return store.abs(join('.tower/worktrees', mission.worktree));
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

describe('init', () => {
  it('creates the directory skeleton, state.json, and the git exclude entry', async () => {
    const result = await store.init();
    expect(result).toEqual({ base: 'main', created: true, retiredAgents: [] });

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
    expect(second).toEqual({ base: 'main', created: false, retiredAgents: [] });
    const state = await store.load();
    expect(state.missions).toHaveLength(1);
  });

  it('keeps the roster on a same-session re-init', async () => {
    await store.init('session-a');
    await store.registerAgent(rosterEntry({ name: 'agent-build', kind: 'worker', sessionId: 'session-a' }));

    const second = await store.init('session-a');

    expect(second).toEqual({ base: 'main', created: false, retiredAgents: [] });
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
    });
    const state = await store.load();
    expect(state.sessionId).toBe('session-b');
    expect(state.roster.agents).toEqual([]);
    expect(state.missions).toHaveLength(1);
    const log = await store.recentLog(5);
    expect(log.some((line) => line.includes(' adopt ') && line.includes('session=session-b') && line.includes('previous=session-a') && line.includes('retired=agent-build,reviewer-a'))).toBe(true);
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

  it('rejects overlapping scopes', async () => {
    const attempt = store.plan([
      { title: 'outer', scope: ['src/a/**'] },
      { title: 'inner', scope: ['src/a/b/**'] },
    ]);
    await expect(attempt).rejects.toThrow(TowerProtocolError);
    await expect(attempt).rejects.toThrow(/scopes overlap/);
  });

  it('rejects deps referencing unknown missions', async () => {
    await expect(
      store.plan([{ title: 'a', scope: ['src/a/**'], deps: ['M9'] }]),
    ).rejects.toThrow(/depends on unknown mission "M9"/);
  });

  it('lets new missions reuse the scope of an already-merged mission', async () => {
    await store.plan([{ title: 'survey', scope: ['src/a/**'] }]);
    await store.updateMission('tower', 'M1', { status: 'merged' });

    const missions = await store.plan([{ title: 'implement', scope: ['src/a/b/**'] }]);
    expect(missions[0]?.id).toBe('M2');

    await expect(store.plan([{ title: 'clash', scope: ['src/a/**'] }])).rejects.toThrow(
      /scopes overlap/,
    );
  });

  it('survey missions reserve no scope and may overlap builds and each other', async () => {
    const missions = await store.plan([
      { title: 'scan layer apis', scope: ['src/layer/**'], kind: 'survey' },
      { title: 'scan core apis', scope: ['src/**'], kind: 'survey' },
      { title: 'implement gemm', scope: ['src/layer/vulkan/**'] },
    ]);
    expect(missions.map((m) => m.kind)).toEqual(['survey', 'survey', 'build']);

    await expect(
      store.plan([{ title: 'touch layers too', scope: ['src/layer/vulkan/shader/**'] }]),
    ).rejects.toThrow(/scopes overlap/);
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

    await expect(store.merge(mission.branch)).rejects.toThrow(/outside mission M1 scope/);

    await store.plan([{ title: 'other', scope: ['src/other/**'] }]);
    await expect(
      store.updateMission('w1', mission.id, { scope: ['src/x/**', 'src/outside.ts'] }),
    ).rejects.toThrow(/cannot change mission scope/);
    await expect(
      store.updateMission('tower', mission.id, { scope: ['src/x/**', 'src/other/**'] }),
    ).rejects.toThrow(/scopes overlap/);

    await store.updateMission('tower', mission.id, { scope: ['src/x/**', 'src/outside.ts'] });
    const log = (await store.recentLog(5)).join('\n');
    expect(log).toContain('mission.update');
    expect(log).toContain('scope=src/x/**,src/outside.ts');
    await store.merge(mission.branch);
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
    const result = await store.merge(mission!.branch);
    expect(result.noop).toBe(true);
    expect(result.mergeCommit).toBe(baseTip);
    expect((await store.load()).missions[0]?.status).toBe('merged');
    expect((await store.recentLog(3)).join('\n')).toContain('merge.noop');
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(baseTip);
  });

  it('refuses to merge a survey branch that has changes', async () => {
    const [mission] = await store.plan([
      { title: 'scan layer', scope: ['src/layer/**'], kind: 'survey' },
    ]);
    const state = await store.load();
    await store.addWorktree(mission!.worktree, mission!.branch, state.base);
    await commitFile(worktreeOf(mission!), 'src/layer/notes.ts', 'oops\n', 'stray edit');

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
    await store.merge(survey!.branch);
    await store.merge(build.branch);
    expect((await store.load()).missions.find((m) => m.id === build.id)?.status).toBe('merged');
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
    await store.plan([{ title: 'gamma', scope: ['src/gamma/**'] }]);
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
});

describe('roster', () => {
  beforeEach(async () => {
    await store.init();
  });

  it('rejects duplicate agent names', async () => {
    await store.registerAgent(rosterEntry({ name: 'w1', kind: 'worker' }));
    await expect(
      store.registerAgent(rosterEntry({ name: 'w1', kind: 'reviewer' })),
    ).rejects.toThrow(/already registered/);
  });

  it('resolveCallerName maps main to tower, resolves roster agents, rejects strangers', async () => {
    await store.registerAgent(rosterEntry({ name: 'w1', kind: 'worker' }));
    const state = await store.load();
    expect(store.resolveCallerName(state, 'main')).toBe('tower');
    expect(store.resolveCallerName(state, 'agent-w1')).toBe('w1');
    expect(() => store.resolveCallerName(state, 'agent-99')).toThrow(TowerProtocolError);
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
});
