import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { slashPathOf } from '@moonshot-ai/testkit/fixtures';
import {
  call,
  createFakeModel,
  held,
  say,
  type FakeModel,
  type Lane,
} from '@moonshot-ai/testkit/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createKimiHarness,
  ErrorCodes,
  type Event,
  type KimiHarness,
} from '#/index';

import { TEST_IDENTITY } from './test-identity';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

function waitForEvent(
  session: { onEvent(listener: (event: Event) => void): () => void },
  predicate: (event: Event) => boolean,
  timeoutMs = 5_000,
): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for session event'));
    }, timeoutMs);
    const unsubscribe = session.onEvent((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

async function configureFakeProvider(harness: KimiHarness): Promise<void> {
  await harness.setConfig({
    providers: {
      local: {
        type: 'kimi',
        baseUrl: 'https://model.example.test/v1',
        apiKey: 'sk-test',
      },
    },
    models: {
      'fake-model': {
        provider: 'local',
        model: 'fake-model',
        maxContextSize: 262144,
      },
    },
    defaultModel: 'fake-model',
  });
}

describe('worktree session move & KV prefix cache', () => {
  let model: FakeModel;
  let mainLane: Lane | undefined;
  let fetchStub: ReturnType<typeof vi.spyOn> | undefined;
  const tempDirs: string[] = [];

  function replies(): Lane {
    mainLane ??= model.lane('main');
    return mainLane;
  }

  beforeEach(() => {
    model = createFakeModel({ checkPromptCache: true, reportCachedTokens: true });
    mainLane = undefined;
    fetchStub = vi.spyOn(globalThis, 'fetch').mockImplementation(model.fetch);
  });

  afterEach(async () => {
    fetchStub?.mockRestore();
    fetchStub = undefined;
    try {
      model.verify();
    } finally {
      await model.close();
      for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    }
  });

  async function makeRepoHarness(initialAgentsMd?: string): Promise<{
    harness: KimiHarness;
    homeDir: string;
    repo: string;
  }> {
    const homeDir = await realpath(await mkdtemp(join(tmpdir(), 'kimi-wt-move-home-')));
    const repoDir = await mkdtemp(join(tmpdir(), 'kimi-wt-move-repo-'));
    tempDirs.push(homeDir, repoDir);
    await git(repoDir, 'init', '-q', '-b', 'main');
    await git(repoDir, 'config', 'user.email', 'test@example.com');
    await git(repoDir, 'config', 'user.name', 'Test');
    await git(repoDir, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(repoDir, 'README.md'), 'hello\n');
    if (initialAgentsMd !== undefined) {
      await writeFile(join(repoDir, 'AGENTS.md'), initialAgentsMd);
    }
    await git(repoDir, 'add', '.');
    await git(repoDir, 'commit', '-q', '-m', 'init');
    const repo = await realpath(repoDir);
    const harness = createKimiHarness({
      homeDir,
      identity: TEST_IDENTITY,
    });
    await configureFakeProvider(harness);
    return { harness, homeDir, repo };
  }

  it('moves an active session into a new worktree, executes tools in the new cwd, and preserves the KV prefix cache across compaction', async () => {
    const { harness, repo } = await makeRepoHarness('Always follow repo rules v1.\n');
    try {
      const session = await harness.createSession({
        id: 'ses_wt_move_cache',
        workDir: repo,
        permission: 'yolo',
      });
      const toolResults: string[] = [];
      const unsubscribe = session.onEvent((event) => {
        if (event.type === 'tool.result') {
          toolResults.push(
            typeof event.output === 'string' ? event.output : JSON.stringify(event.output),
          );
        }
      });

      replies().script(
        call('Bash', { command: 'pwd' }, { id: 'pwd-before' }),
        say('Checked main checkout.'),
        say('Ready to branch out.'),
        call('Read', { path: 'README.md' }, { id: 'read-after' }),
        call('Bash', { command: 'pwd' }, { id: 'pwd-after' }),
        say('Working inside new worktree.'),
        say('Still in the new worktree.'),
        say('Post-compaction turn succeeds.'),
      );
      model.lane('compaction').script(say('Compacted summary of the work so far.'));

      for (const promptText of ['Where are we?', 'Let us plan the refactor.']) {
        const done = waitForEvent(session, (event) => event.type === 'turn.ended');
        await session.prompt(promptText);
        expect(await done).toMatchObject({ reason: 'completed' });
      }
      expect(toolResults[0]).toContain(slashPathOf(repo));

      const created = await harness.createWorktree({ cwd: repo, name: 'feat-move' });
      const requestCountBeforeMove = model.requests('main').length;
      const movedSummary = await session.moveSession(created.cwd);

      expect(session.workDir).toBe(created.cwd);
      expect(movedSummary.workDir).toBe(created.cwd);
      expect(session.summary?.projectWorkDir).toBe(slashPathOf(repo));
      expect(model.requests('main')).toHaveLength(requestCountBeforeMove);

      expect((await harness.listSessions({ workDir: created.cwd })).map((summary) => summary.id)).toEqual([
        session.id,
      ]);
      expect((await harness.listSessions({ workDir: repo })).map((summary) => summary.id)).toEqual([]);
      expect(
        (await harness.listSessions({ workDir: repo, scope: 'project' })).map((summary) => summary.id),
      ).toEqual([session.id]);

      const turn3Done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('Read README and check pwd.');
      expect(await turn3Done).toMatchObject({ reason: 'completed' });
      expect(toolResults.at(-1)).toContain(created.cwd);

      const mainRequests = model.requests('main');
      const firstBody = mainRequests[0]!.body as {
        tools: unknown;
        messages: Array<{ role: string; content: unknown }>;
      };
      const postMoveReq = mainRequests[requestCountBeforeMove]!;
      const postMoveBody = postMoveReq.body as {
        tools: unknown;
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(postMoveBody.tools).toEqual(firstBody.tools);
      expect(postMoveBody.messages.filter((message) => message.role === 'system')).toEqual(
        firstBody.messages.filter((message) => message.role === 'system'),
      );

      const turn3UserTexts = postMoveReq.texts('user');
      const moveReminders = turn3UserTexts.filter((text) =>
        text.includes('The current working directory has moved from'),
      );
      expect(moveReminders).toHaveLength(1);
      expect(moveReminders[0]).toContain(
        `The current working directory has moved from \`${slashPathOf(repo)}\` to \`${created.cwd}\`.`,
      );
      expect(moveReminders[0]).not.toContain('AGENTS.md');

      const afterReadReq = mainRequests[requestCountBeforeMove + 1]!;
      expect(
        afterReadReq
          .texts('user')
          .some((text) => text.includes('were not included in your system prompt')),
      ).toBe(false);

      const turn4Done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('One more turn.');
      expect(await turn4Done).toMatchObject({ reason: 'completed' });
      const turn4Req = model.requests('main').at(-1)!;
      expect(
        turn4Req.texts('user').filter((text) => text.includes('The current working directory has moved')),
      ).toHaveLength(1);

      await session.compact();
      const turn5Done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('Continue after compaction.');
      expect(await turn5Done).toMatchObject({ reason: 'completed' });

      const postCompactReq = model.requests('main').at(-1)!;
      expect(
        postCompactReq
          .texts('user')
          .some((text) =>
            text.includes(
              `The current working directory has moved from \`${slashPathOf(repo)}\` to \`${created.cwd}\`.`,
            ),
          ),
      ).toBe(true);
      expect(model.promptCacheProblems()).toEqual([]);

      unsubscribe();
    } finally {
      await harness.close();
    }
  });

  it('inlines updated AGENTS.md instructions when moving into a worktree created from a different base ref', async () => {
    const { harness, repo } = await makeRepoHarness('Main branch instructions.\n');
    try {
      await git(repo, 'checkout', '-q', '-b', 'legacy-base');
      await writeFile(join(repo, 'AGENTS.md'), 'Legacy base instructions.\n');
      await git(repo, 'add', 'AGENTS.md');
      await git(repo, 'commit', '-q', '-m', 'legacy agents md');
      await git(repo, 'checkout', '-q', 'main');

      const session = await harness.createSession({ id: 'ses_wt_agents_diff', workDir: repo });
      replies().script(say('In main.'), say('In legacy worktree.'));

      const turn1Done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('Start in main.');
      await turn1Done;

      const created = await harness.createWorktree({
        cwd: repo,
        name: 'wt-legacy',
        base: 'legacy-base',
      });
      await session.moveSession(created.cwd);

      const turn2Done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('Now in legacy worktree.');
      await turn2Done;

      const lastReq = model.requests('main').at(-1)!;
      const reminder = lastReq
        .texts('user')
        .find((text) => text.includes('The current working directory has moved from'));
      expect(reminder).toBeDefined();
      expect(reminder).toContain(
        `The instructions from \`${slashPathOf(join(repo, 'AGENTS.md'))}\` no longer apply. The following \`AGENTS.md\` instructions now apply:`,
      );
      expect(reminder).toContain(
        `<!-- From: ${slashPathOf(join(created.cwd, 'AGENTS.md'))} -->\nLegacy base instructions.`,
      );
      expect(model.promptCacheProblems()).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('coalesces consecutive moves, skips A -> B -> A round-trips, and survives restart before the next turn', async () => {
    const { harness: initialHarness, homeDir, repo } = await makeRepoHarness();
    let harness = initialHarness;
    try {
      let session = await harness.createSession({ id: 'ses_wt_coalesce', workDir: repo });
      replies().script(say('Turn 1.'), say('Back in repo.'), say('Resumed in wtB.'));

      const turn1 = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('First.');
      await turn1;

      const wtA = await harness.createWorktree({ cwd: repo, name: 'wt-a' });
      const wtB = await harness.createWorktree({ cwd: repo, name: 'wt-b' });

      await session.moveSession(wtA.cwd);
      await session.moveSession(repo);

      const turn2 = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('Round-trip back to repo.');
      await turn2;
      expect(
        model
          .requests('main')
          .at(-1)!
          .texts('user')
          .some((text) => text.includes('The current working directory has moved')),
      ).toBe(false);

      await session.moveSession(wtA.cwd);
      await session.moveSession(wtB.cwd);
      await harness.close();

      harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
      session = await harness.resumeSession({ id: 'ses_wt_coalesce' });
      expect(session.workDir).toBe(wtB.cwd);

      const turn3 = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('After restart.');
      await turn3;

      const lastReq = model.requests('main').at(-1)!;
      expect(
        lastReq
          .texts('user')
          .some((text) =>
            text.includes(
              `The current working directory has moved from \`${slashPathOf(repo)}\` to \`${wtB.cwd}\`.`,
            ),
          ),
      ).toBe(true);
      expect(lastReq.texts('user').some((text) => text.includes(wtA.cwd))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('rejects moving across projects or while a turn is running without corrupting the session', async () => {
    const { harness, repo } = await makeRepoHarness();
    const otherRepo = await realpath(await mkdtemp(join(tmpdir(), 'kimi-wt-other-repo-')));
    tempDirs.push(otherRepo);
    await mkdir(otherRepo, { recursive: true });
    await git(otherRepo, 'init', '-q', '-b', 'main');
    try {
      const session = await harness.createSession({ id: 'ses_wt_guards', workDir: repo });
      const wt = await harness.createWorktree({ cwd: repo, name: 'wt-guard' });

      await expect(session.moveSession(otherRepo)).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
      });
      expect(session.workDir).toBe(slashPathOf(repo));

      replies().script(held('mid-turn', say('Finished turn.')));
      const done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('Hold the turn.');
      await model.hold('mid-turn').reached();

      await expect(session.moveSession(wt.cwd)).rejects.toMatchObject({
        code: ErrorCodes.TURN_AGENT_BUSY,
      });
      expect(session.workDir).toBe(slashPathOf(repo));

      model.hold('mid-turn').release();
      await done;
    } finally {
      await harness.close();
    }
  });

  it('preserves global AGENTS.md changes across move and syncs workDir on stale reload in another client', async () => {
    const { harness: harnessA, homeDir, repo } = await makeRepoHarness('Repo instructions v1.\n');
    const globalAgentsMd = join(homeDir, 'AGENTS.md');
    await writeFile(globalAgentsMd, 'Global instructions v1.\n');
    const harnessB = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    await configureFakeProvider(harnessB);
    try {
      replies().script(say('Turn 1 in client A.'), say('Turn 2 in client B after move.'));
      const sessionA = await harnessA.createSession({ id: 'ses_wt_global_stale', workDir: repo });
      const turn1 = waitForEvent(sessionA, (event) => event.type === 'turn.ended');
      await sessionA.prompt('Hello from A.');
      await turn1;

      const sessionB = await harnessB.resumeSession({ id: sessionA.id });
      let workDirDuringStaleHandler: string | undefined;
      sessionB.setStaleReloadHandler(async () => {
        workDirDuringStaleHandler = sessionB.workDir;
      });

      await writeFile(globalAgentsMd, 'Global instructions v2 changed right before move.\n');
      const wt = await harnessA.createWorktree({ cwd: repo, name: 'wt-stale-sync' });
      await sessionA.moveSession(wt.cwd);
      await sessionA.close();

      const turn2 = waitForEvent(sessionB, (event) => event.type === 'turn.ended');
      await sessionB.prompt('Continue from B.');
      await turn2;

      expect(workDirDuringStaleHandler).toBe(wt.cwd);
      expect(sessionB.workDir).toBe(wt.cwd);

      const postMoveTexts = model.requests('main').at(-1)!.texts('user').join('\n');
      expect(postMoveTexts).toContain(
        `The current working directory has moved from \`${slashPathOf(repo)}\` to \`${wt.cwd}\`.`,
      );
      expect(postMoveTexts).toContain(slashPathOf(globalAgentsMd));
    } finally {
      await harnessA.close();
      await harnessB.close();
    }
  });
});
