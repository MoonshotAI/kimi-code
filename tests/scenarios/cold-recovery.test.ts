import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { bashPathOf, createTestHome, slashPathOf, until, writeKimiConfig, type TestHome } from '@moonshot-ai/testkit/fixtures';
import { KapProcess, type KapSocket, type KapTurn } from '@moonshot-ai/testkit/kap';
import { bash, fakeModelConfig, held, say, type FakeModel } from '@moonshot-ai/testkit/model';
import { modelFixtures, type ModelFixtures } from '@moonshot-ai/testkit/vitest';
import { expect, test as base } from 'vitest';

import { corpusProblems, installCorpus, releasedCorpora, RELEASED_ANSWER, RELEASED_PROMPT, type ReleasedCorpus } from './support/released-corpus';

const test = base.extend<ModelFixtures>(modelFixtures());
const corpora = await releasedCorpora();
const CORPUS_TIMEOUT_MS = 90_000;

function startServer(home: TestHome): Promise<KapProcess> {
  return KapProcess.start({ home, env: { KIMI_CODE_PERSISTENCE_MINIDB_READMODEL: undefined } });
}

async function subscribe(server: KapProcess, sessionId: string): Promise<KapSocket> {
  const socket = await server.connect();
  await socket.subscribe(sessionId);
  return socket;
}

async function continueAndRecover(corpus: ReleasedCorpus, home: TestHome, model: FakeModel): Promise<void> {
  const { writer, sessionId: id } = corpus.manifest;
  await installCorpus(corpus, home);
  await writeKimiConfig(home.dataDir, fakeModelConfig(model, { type: 'openai' }));
  const first = await startServer(home);
  let history: readonly KapTurn[];
  try {
    history = (await subscribe(first, id)).turns(id);
    expect(history, `history written by ${writer}`).toMatchObject([{ status: 'ended', outcome: 'completed', items: [
      { type: 'user_message', text: RELEASED_PROMPT },
      { type: 'assistant_message', text: RELEASED_ANSWER },
    ] }]);
  } finally {
    await first.close();
  }
  const requestsBefore = model.requests('main').length;
  const second = await startServer(home);
  let completed: readonly KapTurn[];
  try {
    expect(second.pid).not.toBe(first.pid);
    const channel = await subscribe(second, id);
    expect(channel.turns(id), `history written by ${writer} after a restart`).toEqual(history);
    model.script(say('The previous greeting is still here.'));
    await second.prompt(id, 'Continue the greeting.');
    await second.waitIdle(id);
    completed = await second.turns(id);
    const turnNumber = completed.at(-1)?.['turn_number'];
    const wire = join(home.dataDir, Object.keys(corpus.manifest.files).find(name => name.endsWith('/agents/main/wire.jsonl'))!);
    await until(`the turn continuing ${writer} is on disk before the process is killed`, async () => (await readFile(wire, 'utf8')).trimEnd().split('\n').some(line => {
      const record = JSON.parse(line) as { type: string; turnId?: number; reason?: string };
      return record.type === 'turn.ended' && record.turnId === turnNumber && record.reason === 'completed';
    }));
  } finally {
    await second.crash();
  }
  expect(model.requests('main')[requestsBefore]!.texts('assistant'), `context of the turn continuing ${writer}`).toContain(RELEASED_ANSWER);
  expect(completed, `turns continuing ${writer}`).toMatchObject([history[0], { status: 'ended', outcome: 'completed', items: [
    { type: 'user_message', text: 'Continue the greeting.' }, { type: 'assistant_message', text: 'The previous greeting is still here.' },
  ] }]);
  const recovered = await startServer(home);
  try {
    expect(recovered.pid).not.toBe(second.pid);
    expect((await subscribe(recovered, id)).turns(id), `turns continuing ${writer} after a crash`).toEqual(completed);
  } finally {
    await recovered.close();
  }
}

test('every released corpus is complete and unchanged since it was captured', async () => {
  expect(corpora.map(corpus => corpus.version), 'released corpora').not.toEqual([]);
  for (const corpus of corpora) expect(await corpusProblems(corpus), corpus.manifest.writer).toEqual([]);
});

test('continues sessions written by every released version in fresh KAP processes and recovers the completed turn after a crash', { timeout: CORPUS_TIMEOUT_MS * Math.max(corpora.length, 1) }, async ({ model }) => {
  expect(corpora.map(corpus => corpus.version), 'released corpora').not.toEqual([]);
  await model.listen();
  for (const corpus of corpora) {
    const home = await createTestHome(`cold-recovery-${corpus.version}`);
    try {
      await continueAndRecover(corpus, home, model);
    } finally {
      await home.remove();
    }
  }
});

interface ProjectsFile {
  readonly projects: Record<string, { root: string }>;
  deleted_project_ids: string[];
}

interface RepositoryLayout {
  readonly main: string;
  readonly worktree: string;
}

async function writeConfig(home: TestHome, model: FakeModel): Promise<void> {
  await writeKimiConfig(home.dataDir, { ...fakeModelConfig(model, { type: 'openai' }), defaultPermissionMode: 'yolo' });
}

async function editProjects(home: TestHome, edit: (projects: ProjectsFile) => void): Promise<void> {
  const path = join(home.dataDir, 'projects.json');
  const projects = JSON.parse(await readFile(path, 'utf8')) as ProjectsFile;
  edit(projects);
  await writeFile(path, JSON.stringify(projects));
}

async function repositoryWithWorktree(home: TestHome): Promise<RepositoryLayout> {
  const main = join(home.workspace, 'app');
  const worktree = join(home.workspace, 'app-fix');
  const gitDir = join(main, '.git', 'worktrees', 'app-fix');
  await mkdir(gitDir, { recursive: true });
  await mkdir(join(worktree, 'src'), { recursive: true });
  await writeFile(join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/fix\n');
  await writeFile(join(gitDir, 'commondir'), '../..\n');
  await writeFile(join(gitDir, 'gitdir'), `${join(worktree, '.git')}\n`);
  await writeFile(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
  return { main, worktree };
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path;
}

async function toolOutputOf(model: FakeModel, request: number): Promise<string | undefined> {
  return model.request(request).view.messages.find((message) => message.role === 'tool')?.text.replace(/^Wall time: \d+\.\d{3} seconds\n/, '');
}

interface MainWireRecord {
  readonly type: string;
  readonly promptId?: string;
  readonly turnId?: number;
  readonly message?: { readonly id?: string };
  readonly event?: { readonly type?: string; readonly turnId?: string };
}

async function mainWireOf(home: TestHome, sessionId: string): Promise<readonly MainWireRecord[]> {
  const sessions = join(home.dataDir, 'sessions');
  for (const workspace of await readdir(sessions)) {
    const wire = join(sessions, workspace, sessionId, 'agents', 'main', 'wire.jsonl');
    if (!existsSync(wire)) continue;
    return (await readFile(wire, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as MainWireRecord);
  }
  return [];
}

async function promptRequestOnDisk(home: TestHome, sessionId: string, promptId: string): Promise<boolean> {
  const records = await mainWireOf(home, sessionId);
  const turnId = records.find((record) => record.type === 'turn.prompt' && record.promptId === promptId)?.turnId;
  return turnId !== undefined &&
    records.some((record) => record.type === 'context.append_message' && record.message?.id === promptId) &&
    records.some((record) => record.type === 'context.append_loop_event' && record.event?.type === 'step.begin' && record.event.turnId === String(turnId));
}

test('keeps a released session without an environment cwd following the current root of its workspace', { timeout: CORPUS_TIMEOUT_MS }, async ({ model }) => {
  const corpus = corpora.at(-1)!;
  await model.listen();
  const home = await createTestHome(`cold-recovery-follow-${corpus.version}`);
  try {
    await installCorpus(corpus, home);
    await writeConfig(home, model);
    const moved = join(home.workspace, 'moved');
    await mkdir(moved);
    await editProjects(home, (projects) => {
      for (const project of Object.values(projects.projects)) project.root = moved;
    });
    const id = corpus.manifest.sessionId;
    const server = await startServer(home);
    try {
      expect((await server.session(id)).cwd, 'cwd of the released session').toBe(slashPathOf(moved));
      model.script(bash('pwd -P'), say('Still at the root.'));
      const before = model.requests('main').length;
      await server.prompt(id, 'Where are you?');
      await server.waitIdle(id);
      expect(await toolOutputOf(model, before + 1)).toBe(`${bashPathOf(await realpath(moved))}\n`);
      expect((await server.session(id)).cwd).toBe(slashPathOf(moved));
    } finally {
      await server.close();
    }
    const state = join(home.dataDir, Object.keys(corpus.manifest.files).find((name) => name.endsWith('/state.json'))!);
    expect(JSON.parse(await readFile(state, 'utf8')), 'state.json of the released session').not.toHaveProperty('environmentCwd');
  } finally {
    await home.remove();
  }
});

test('continues a session at the root of a managed project in the new folder after the folder is renamed and made its primary', { timeout: CORPUS_TIMEOUT_MS }, async ({ model }) => {
  await model.listen();
  const home = await createTestHome('cold-recovery-renamed');
  try {
    await writeConfig(home, model);
    const notes = join(home.workspace, 'notes');
    const renamed = join(home.workspace, 'notes-renamed');
    await mkdir(notes);
    const first = await startServer(home);
    let workspaceId: string;
    let sessionId: string;
    try {
      workspaceId = (await first.rest.post<{ readonly id: string }>('/api/v1/workspaces', { root: notes })).id;
      sessionId = (
        await first.rest.post<{ readonly id: string }>('/api/v1/sessions', { workspace_id: workspaceId, metadata: { cwd: notes } })
      ).id;
      model.script(say('Written before the rename.'));
      await first.prompt(sessionId, 'Hello.');
      await first.waitIdle(sessionId);
    } finally {
      await first.close();
    }
    await rename(notes, renamed);
    const second = await startServer(home);
    try {
      const workspace = `/api/v1/workspaces/${workspaceId}`;
      await second.rest.patch(workspace, { additional_dirs: [renamed] });
      await second.rest.post(`${workspace}/primary`, { path: renamed });
      await second.rest.patch(workspace, { additional_dirs: [] });

      const continued = await second.session(sessionId);
      expect(continued).toMatchObject({ workspace_id: workspaceId });
      expect(pathKey(continued.cwd)).toBe(pathKey(renamed));
      expect((await subscribe(second, sessionId)).turns(sessionId)).toHaveLength(1);
      model.script(bash('pwd -P'), say('Continued.'));
      const before = model.requests('main').length;
      await second.prompt(sessionId, 'Where are you?');
      await second.waitIdle(sessionId);
      expect(model.request(before).texts('assistant')).toContain('Written before the rename.');
      expect(await toolOutputOf(model, before + 1)).toBe(`${bashPathOf(await realpath(renamed))}\n`);
      expect(await second.turns(sessionId)).toHaveLength(2);
    } finally {
      await second.close();
    }
  } finally {
    await home.remove();
  }
});

test('keeps a pinned session in its directory and its interrupted prompt after the server crashes mid-turn and restarts', { timeout: CORPUS_TIMEOUT_MS }, async ({ model }) => {
  await model.listen();
  const home = await createTestHome('cold-recovery-pinned');
  try {
    await writeConfig(home, model);
    const { main, worktree } = await repositoryWithWorktree(home);
    const pinnedDir = join(worktree, 'src');
    const first = await startServer(home);
    let created: Awaited<ReturnType<KapProcess['createSession']>>;
    try {
      const atMain = await first.createSession({ cwd: main });
      created = await first.createSession({ cwd: pinnedDir });
      expect(created).toMatchObject({ workspace_id: atMain.workspace_id, cwd: slashPathOf(pinnedDir) });
      model.script(held('mid-turn', say('never finished')));
      const prompt = await first.prompt(created.id, 'Start something long.');
      await model.hold('mid-turn').reached();
      await until('the interrupted prompt and its request are on disk before the process is killed', () =>
        promptRequestOnDisk(home, created.id, prompt.user_message_id));
    } finally {
      await first.crash();
    }
    model.hold('mid-turn').release();
    const second = await startServer(home);
    try {
      expect(second.pid).not.toBe(first.pid);
      expect(await second.session(created.id)).toMatchObject({ workspace_id: created.workspace_id, cwd: slashPathOf(pinnedDir) });
      expect(await second.turns(created.id), 'turns after the crash').toMatchObject([{
        status: 'ended',
        outcome: 'interrupted',
        end_reason: 'aborted',
        items: [{ type: 'user_message', text: 'Start something long.' }],
      }]);
      const interrupted = model.requests('main').at(-1)!.view.messages;
      model.script(bash('pwd -P'), say('Still pinned.'));
      const before = model.requests('main').length;
      await second.prompt(created.id, 'Where are you?');
      await second.waitIdle(created.id);
      expect(model.requests('main')[before]!.view.messages.slice(0, interrupted.length), 'context after the crash').toEqual(interrupted);
      expect(await toolOutputOf(model, before + 1)).toBe(`${bashPathOf(await realpath(pinnedDir))}\n`);
      expect(await second.session(created.id)).toMatchObject({ cwd: slashPathOf(pinnedDir) });
    } finally {
      await second.close();
    }
  } finally {
    await home.remove();
  }
});

test('revives the repository project of a pinned worktree session whose project was deleted from the catalog', { timeout: CORPUS_TIMEOUT_MS }, async ({ model }) => {
  await model.listen();
  const home = await createTestHome('cold-recovery-revive');
  try {
    await writeConfig(home, model);
    const { main, worktree } = await repositoryWithWorktree(home);
    const first = await startServer(home);
    let created: Awaited<ReturnType<KapProcess['createSession']>>;
    try {
      created = await first.createSession({ cwd: worktree });
    } finally {
      await first.close();
    }
    await editProjects(home, (projects) => {
      delete projects.projects[created.workspace_id];
      projects.deleted_project_ids.push(created.workspace_id);
    });
    const second = await startServer(home);
    try {
      expect(await second.session(created.id)).toMatchObject({ workspace_id: created.workspace_id, cwd: slashPathOf(worktree) });
      model.script(bash('pwd -P'), say('Revived.'));
      const before = model.requests('main').length;
      await second.prompt(created.id, 'Where are you?');
      await second.waitIdle(created.id);
      expect(await toolOutputOf(model, before + 1)).toBe(`${bashPathOf(await realpath(worktree))}\n`);
      const workspaces = await second.rest.get<{ items: { id: string; root: string }[] }>('/api/v1/workspaces');
      const repositoryDirs = [main, worktree].map(pathKey);
      expect(
        workspaces.items
          .filter((item) => repositoryDirs.includes(pathKey(item.root)))
          .map((item) => ({ id: item.id, root: pathKey(item.root) })),
      ).toEqual([{ id: created.workspace_id, root: pathKey(main) }]);
    } finally {
      await second.close();
    }
  } finally {
    await home.remove();
  }
});
