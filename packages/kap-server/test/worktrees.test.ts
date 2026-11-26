import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AgentEnvironmentBindingService,
  AgentLoopService,
  IAgentEnvironmentBindingService,
  IAgentEnvironmentService,
  IAgentLoopService,
  IProjectTrust,
  IWorktreeService,
  closeSessionById,
  getLiveSessionById,
  patchSessionMetadata,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { ErrorCode } from '../src/protocol/error-codes';
import type { Session } from '../src/protocol/session';
import { repointSession } from '../src/services/worktrees/sessionRepoint';
import { SessionWorktreeService } from '../src/services/worktrees/sessionWorktreeService';
import { commitAll, git, hangingRemote } from './helpers/gitRepo';
import { type Envelope, useWorktreeServer } from './helpers/worktreeServer';

describe('server-v2 session worktrees', () => {
  const fixture = useWorktreeServer('worktrees');
  const {
    post,
    get,
    addRemote,
    commitOnRemote,
    createWorkspace,
    project,
    createWorktreeSession,
    settled,
    settledWorktree,
    untilStep,
    branchOf,
    forceRunning,
    stored,
    sessionEvents,
    mainAgent,
    worktreeDirectories,
    expectNothingLeft,
  } = fixture;

  function agentState(id: string) {
    const { accessor } = mainAgent(id);
    return {
      cwd: accessor.get(IAgentEnvironmentBindingService).current.cwd,
      workDir: accessor.get(IAgentEnvironmentService).workspaceRoots().workDir,
      prompt: accessor.get(IAgentLoopService).getSystemPrompt(),
    };
  }

  it('re-points a fresh session at another directory and back to the workspace root', async () => {
    const { root, workspaceId } = await project('repoint');
    const worktree = join(fixture.scratch, 'repoint-wt');
    git(root, 'worktree', 'add', '-q', '-b', 'side', worktree);
    await writeFile(join(worktree, 'only-here.txt'), 'x\n');
    const created = await post<Session>('/sessions', { workspace_id: workspaceId });
    const id = created.data.id;
    expect(created.data.cwd).toBe(root);
    expect(agentState(id).prompt).not.toContain(worktree);

    await repointSession(fixture.server.core, id, worktree);

    const moved = await get<Session>(`/sessions/${id}`);
    expect(moved.data.cwd).toBe(worktree);
    expect(moved.data.workspace_id).toBe(workspaceId);
    const status = await post<{ branch: string; entries: Record<string, string> }>(
      `/sessions/${id}/fs:git_status`,
      { include_pull_request: false },
    );
    expect(status.data.branch).toBe('side');
    expect(status.data.entries).toEqual({ 'only-here.txt': 'untracked' });
    const agent = agentState(id);
    expect(agent).toMatchObject({ cwd: worktree, workDir: worktree });
    expect(agent.prompt).toContain(worktree);

    await repointSession(fixture.server.core, id, undefined);

    const back = await get<Session>(`/sessions/${id}`);
    expect(back.data.cwd).toBe(root);
    expect(await branchOf(id)).toBe('main');
    const restored = agentState(id);
    expect(restored.workDir).toBe(root);
    expect(restored.prompt).not.toContain(worktree);
  });

  it('creates a worktree from a local branch and moves the session into it', async () => {
    const { root, workspaceId } = await project('local-create');
    await post(`/workspaces/${workspaceId}/trust`);
    const events = await sessionEvents();

    const created = await createWorktreeSession(workspaceId, { source_branch: 'main' });

    expect(created.cwd).toBe(root);
    expect(created.metadata).toBeUndefined();
    expect(created.worktree).toMatchObject({
      setup: {
        status: 'running',
        purpose: 'create',
        request: { source_branch: 'main' },
        commands_ran: 0,
      },
    });
    expect(created.worktree?.path).toBeUndefined();
    expect(created.worktree?.setup.steps.map((step) => step.kind)).toEqual(['create']);

    const ready = await settled(created.id);
    const worktree = ready.worktree!;
    expect(worktree.setup.status).toBe('ready');
    expect(worktree.setup.commands_ran).toBe(1);
    expect(worktree.setup.ended_at).toBeDefined();
    expect(worktree.branch).toMatch(/^kimi\/\d{4}-[0-9a-f]{4}$/);
    const worktreeService = fixture.server.core.accessor.get(IWorktreeService);
    expect(worktree.path).toBe(join(worktreeService.worktreesDir(root), worktree.branch!.slice('kimi/'.length)));
    expect(worktree.base).toEqual({ ref: 'main', remote: false, commit: git(root, 'rev-parse', 'main') });
    expect(worktree.included_local_changes).toBe(false);
    expect(worktree.missing).toBeUndefined();
    expect(worktree.setup.steps).toEqual([
      {
        kind: 'create',
        state: 'done',
        ref: 'main',
        command: `git worktree add --no-track -b ${worktree.branch} ${worktree.path} refs/heads/main`,
      },
    ]);
    expect(ready.cwd).toBe(worktree.path);
    expect(ready.workspace_id).toBe(workspaceId);
    expect(git(worktree.path!, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(worktree.branch);

    expect(await branchOf(created.id)).toBe(worktree.branch);
    const agent = agentState(created.id);
    expect(agent.workDir).toBe(worktree.path);
    expect(agent.prompt).toContain(worktree.path);
    const live = getLiveSessionById(fixture.server.core.accessor, created.id)!;
    expect(live.accessor.get(IProjectTrust).isTrusted()).toBe(true);

    await expect.poll(() => events.at(-1)?.session.worktree?.setup.status).toBe('ready');
    const mine = events.filter((event) => event.session.id === created.id);
    expect(mine[0]).toMatchObject({ change: 'created', session: { worktree: { setup: { status: 'running' } } } });
    expect(mine.slice(1).every((event) => event.change === 'updated')).toBe(true);
    expect(
      mine.some((event) => event.session.worktree?.setup.steps[0]?.state === 'running'),
    ).toBe(true);
    expect(mine.at(-1)?.session.cwd).toBe(worktree.path);

    const listed = await get<{ items: Session[] }>(`/sessions?workspace_id=${workspaceId}`);
    expect(listed.data.items.find((item) => item.id === created.id)?.worktree?.path).toBe(worktree.path);
    expect((await worktreeService.list(root)).worktrees.find((entry) => entry.path === worktree.path)).toMatchObject({
      branch: worktree.branch,
      managed: true,
      missing: false,
    });
  });

  it('copies the ignored files listed in .worktreeinclude into the new worktree', async () => {
    const { root, workspaceId } = await project('include-files');
    await writeFile(join(root, '.gitignore'), '.env\nbuild/\n');
    await writeFile(join(root, '.worktreeinclude'), '.env\n');
    commitAll(root, 'ignore local files');
    await writeFile(join(root, '.env'), 'TOKEN=local\n');
    await mkdir(join(root, 'build'));
    await writeFile(join(root, 'build', 'out.js'), 'built\n');

    const created = await createWorktreeSession(workspaceId);
    expect(created.worktree?.setup.steps.map((step) => step.kind)).toEqual(['create', 'include']);
    const ready = await settled(created.id);
    const path = ready.worktree!.path!;

    expect(ready.worktree!.setup.status).toBe('ready');
    expect(ready.worktree!.setup.steps.at(-1)).toEqual({ kind: 'include', state: 'done' });
    expect(await readFile(join(path, '.env'), 'utf-8')).toBe('TOKEN=local\n');
    expect(existsSync(join(path, 'build'))).toBe(false);
  });

  it('starts from the freshly fetched remote branch without moving the local branch', async () => {
    const { root, workspaceId } = await project('remote-create');
    const bare = addRemote(root);
    const localTip = git(root, 'rev-parse', 'main');
    const remoteTip = await commitOnRemote(bare, 'remote.txt', 'from remote\n');

    const created = await createWorktreeSession(workspaceId, { use_remote: true });
    expect(created.worktree?.setup.steps).toMatchObject([
      {
        kind: 'fetch',
        state: 'pending',
        ref: 'origin/main',
        command: 'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main',
      },
      { kind: 'create', state: 'pending', ref: 'origin/main' },
    ]);

    const ready = await settled(created.id);
    expect(ready.worktree?.setup).toMatchObject({ status: 'ready', commands_ran: 2 });
    expect(ready.worktree?.base).toEqual({ ref: 'origin/main', remote: true, commit: remoteTip });
    expect(git(ready.worktree!.path!, 'rev-parse', 'HEAD')).toBe(remoteTip);
    expect(existsSync(join(ready.worktree!.path!, 'remote.txt'))).toBe(true);
    expect(git(root, 'rev-parse', 'main')).toBe(localTip);
    expect(
      git(root, 'for-each-ref', '--format=%(upstream)', `refs/heads/${ready.worktree!.branch}`),
    ).toBe('');
  });

  it('creates nothing when the fetch fails, then retries from the local branch', async () => {
    const { root, workspaceId } = await project('fetch-failure');
    const bare = addRemote(root);
    await rm(bare, { recursive: true, force: true });
    const before = await worktreeDirectories();

    const created = await createWorktreeSession(workspaceId, { use_remote: true });
    const failed = await settled(created.id);

    expect(failed.worktree?.setup).toMatchObject({
      status: 'failed',
      stopped_step: 'fetch',
      failure: { kind: 'fetch_failed', remote_ref: 'origin/main' },
    });
    expect(failed.worktree?.setup.steps[0]).toMatchObject({ kind: 'fetch', state: 'failed' });
    expect(failed.worktree?.setup.steps[0]?.output).toMatch(/fatal|not appear to be a git repository/);
    expect(failed.worktree?.setup.steps[1]).toMatchObject({ kind: 'create', state: 'pending' });
    expect(failed.worktree?.path).toBeUndefined();
    expect(failed.cwd).toBe(root);
    await expectNothingLeft(root, before);

    const retried = await post<Session>(`/sessions/${created.id}/worktree:retry`, { use_remote: false });
    expect(retried.code).toBe(0);
    expect(retried.data.worktree?.setup).toMatchObject({
      status: 'running',
      request: { source_branch: 'main', use_remote: false },
    });
    expect(retried.data.worktree?.setup.failure).toBeUndefined();
    expect(retried.data.worktree?.setup.steps.map((step) => step.kind)).toEqual(['create']);
    const ready = await settled(created.id);
    expect(ready.worktree?.setup.status).toBe('ready');
    expect(ready.worktree?.base).toMatchObject({ ref: 'main', remote: false });
    expect(ready.cwd).toBe(ready.worktree?.path);
  });

  it('treats a branch that vanished from the remote as having no remote', async () => {
    const { root, workspaceId } = await project('stale-remote');
    const bare = addRemote(root);
    git(root, 'checkout', '-q', '-b', 'feature');
    git(root, 'push', '-q', '-u', 'origin', 'feature');
    git(root, 'checkout', '-q', 'main');
    git(bare, 'branch', '-D', 'feature');

    const created = await createWorktreeSession(workspaceId, { source_branch: 'feature', use_remote: true });
    expect(created.worktree?.setup.steps[0]).toMatchObject({ kind: 'fetch', ref: 'origin/feature' });
    const ready = await settled(created.id);

    expect(ready.worktree?.setup.status).toBe('ready');
    expect(ready.worktree?.setup.steps).toMatchObject([
      { kind: 'fetch', state: 'skipped' },
      { kind: 'create', state: 'done', ref: 'feature' },
    ]);
    expect(ready.worktree?.setup.steps[1]?.command).toMatch(/ refs\/heads\/feature$/);
    expect(ready.worktree?.base).toMatchObject({ ref: 'feature', remote: false });
  });

  it('carries uncommitted work into the worktree unstaged and leaves the main directory untouched', async () => {
    const { root, workspaceId } = await project('local-changes');
    await writeFile(join(root, 'README.md'), 'hello\nedited\n');
    await writeFile(join(root, 'staged.txt'), 'staged\n');
    git(root, 'add', 'staged.txt');
    await rm(join(root, 'notes.txt'));
    await writeFile(join(root, 'untracked.txt'), 'new\n');
    await writeFile(join(root, '.gitignore'), 'ignored.log\n');
    await writeFile(join(root, 'ignored.log'), 'noise\n');
    const statusBefore = git(root, 'status', '--porcelain');
    const indexBefore = await readFile(join(root, '.git', 'index'));

    const created = await createWorktreeSession(workspaceId, { include_local_changes: true });
    expect(created.worktree?.setup.steps.map((step) => step.kind)).toEqual(['create', 'changes']);
    const ready = await settled(created.id);

    expect(ready.worktree?.setup).toMatchObject({ status: 'ready', commands_ran: 2 });
    expect(ready.worktree?.included_local_changes).toBe(true);
    expect(ready.worktree?.setup.steps[1]).toMatchObject({ kind: 'changes', state: 'done' });
    expect(ready.worktree?.setup.steps[1]?.command).toMatch(/^git cherry-pick --no-commit [0-9a-f]{10}$/);
    const path = ready.worktree!.path!;
    expect(git(path, 'status', '--porcelain').split('\n').toSorted()).toEqual([
      ' D notes.txt',
      ' M README.md',
      '?? .gitignore',
      '?? staged.txt',
      '?? untracked.txt',
    ]);
    expect(await readFile(join(path, 'README.md'), 'utf-8')).toBe('hello\nedited\n');
    expect(existsSync(join(path, 'ignored.log'))).toBe(false);
    expect(git(path, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(root, 'status', '--porcelain')).toBe(statusBefore);
    expect((await readFile(join(root, '.git', 'index'))).equals(indexBefore)).toBe(true);
  });

  it('skips the changes step when the main directory is clean', async () => {
    const { workspaceId } = await project('clean-changes');

    const created = await createWorktreeSession(workspaceId, { include_local_changes: true });

    expect(created.worktree?.setup.steps.map((step) => step.kind)).toEqual(['create']);
    expect((await settled(created.id)).worktree?.included_local_changes).toBe(false);
  });

  it('reports conflicting files and leaves nothing behind when local changes do not apply', async () => {
    const { root, workspaceId } = await project('conflict');
    const bare = addRemote(root);
    await commitOnRemote(bare, 'notes.txt', 'remote rewrite\n');
    await writeFile(join(root, 'notes.txt'), 'local rewrite\n');
    const before = await worktreeDirectories();

    const created = await createWorktreeSession(workspaceId, {
      use_remote: true,
      include_local_changes: true,
    });
    const failed = await settled(created.id);

    expect(failed.worktree?.setup).toMatchObject({
      status: 'failed',
      stopped_step: 'changes',
      failure: { kind: 'conflict', conflict_files: ['notes.txt'], remote_ref: 'origin/main' },
    });
    expect(failed.worktree?.setup.steps.map((step) => step.state)).toEqual(['done', 'done', 'failed']);
    expect(failed.worktree?.path).toBeUndefined();
    expect(failed.cwd).toBe(root);
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('local rewrite\n');
    await expectNothingLeft(root, before);

    const local = await post<Session>(`/sessions/${created.id}/worktree:use_local`);
    expect(local.data.worktree).toMatchObject({ setup: { status: 'local' } });
    expect(local.data.worktree?.path).toBeUndefined();
    expect(local.data.cwd).toBe(root);
    const again = await post<Session>(`/sessions/${created.id}/worktree:retry`);
    expect(again.code).toBe(ErrorCode.WORKTREE_STATE_INVALID);
  });

  it('cancels a running setup, leaving nothing behind', async () => {
    const { root, workspaceId } = await project('cancel');
    hangingRemote(root);
    const before = await worktreeDirectories();

    const created = await createWorktreeSession(workspaceId, { use_remote: true });
    await untilStep(created.id, 'fetch', 'running');
    const fork = await post<Session>(`/sessions/${created.id}:fork`, {});
    expect(fork.code).toBe(ErrorCode.WORKTREE_STATE_INVALID);
    const cancelled = await post<Session>(`/sessions/${created.id}/worktree:cancel`);

    expect(cancelled.code).toBe(0);
    expect(cancelled.data.worktree?.setup).toMatchObject({ status: 'stopped', stopped_step: 'fetch' });
    expect(cancelled.data.worktree?.setup.steps).toMatchObject([
      { kind: 'fetch', state: 'stopped' },
      { kind: 'create', state: 'pending' },
    ]);
    expect(cancelled.data.cwd).toBe(root);
    await expectNothingLeft(root, before);
    const twice = await post<Session>(`/sessions/${created.id}/worktree:cancel`);
    expect(twice.code).toBe(ErrorCode.WORKTREE_STATE_INVALID);
  });

  it('moves the session back when setup is cancelled while it switches into the worktree', async () => {
    const { root, workspaceId } = await project('cancel-repoint');
    const before = await worktreeDirectories();
    const worktreesHome = join(fixture.home, 'worktrees');
    const originalBind = AgentEnvironmentBindingService.prototype.bind;
    const originalBindProfile = AgentLoopService.prototype.bindProfile;
    const abort = vi.spyOn(AbortController.prototype, 'abort');
    let sessionId = '';
    let switching = false;
    vi.spyOn(AgentEnvironmentBindingService.prototype, 'bind').mockImplementation(function (
      this: AgentEnvironmentBindingService,
      ...args: Parameters<AgentEnvironmentBindingService['bind']>
    ) {
      if (args[1]?.startsWith(worktreesHome) === true) switching = true;
      return originalBind.apply(this, args);
    });
    const bindProfile = vi
      .spyOn(AgentLoopService.prototype, 'bindProfile')
      .mockImplementation(async function (this: AgentLoopService, ...args: Parameters<AgentLoopService['bindProfile']>) {
        if (switching) {
          switching = false;
          const aborts = abort.mock.calls.length;
          await vi.waitFor(() => {
            if (sessionId === '') throw new Error('the session has not been created yet');
          });
          void post(`/sessions/${sessionId}/worktree:cancel`);
          await vi.waitFor(() => {
            if (abort.mock.calls.length === aborts) throw new Error('the setup has not been cancelled yet');
          });
        }
        return originalBindProfile.apply(this, args);
      });
    onTestFinished(() => {
      vi.restoreAllMocks();
    });

    sessionId = (await createWorktreeSession(workspaceId)).id;
    const session = await settled(sessionId);

    expect(bindProfile).toHaveBeenCalled();
    expect(session.worktree?.setup).toMatchObject({ status: 'stopped', stopped_step: 'create' });
    expect(session.worktree?.path).toBeUndefined();
    expect(session.cwd).toBe(root);
    expect(agentState(sessionId)).toMatchObject({ cwd: undefined, workDir: root });
    await expectNothingLeft(root, before);
  });

  async function sentTexts(id: string): Promise<string[]> {
    const page = await get<{ turns: { items: { type: string; text?: string }[] }[] }>(
      `/sessions/${id}/agents/main/turns`,
    );
    return page.data.turns.flatMap((turn) =>
      turn.items.flatMap((item) => (item.type === 'user_message' && item.text !== undefined ? [item.text] : [])),
    );
  }

  it('holds a prompt sent during setup and sends it once the worktree is ready', async () => {
    const { workspaceId } = await project('held-ready');
    const originalBind = AgentEnvironmentBindingService.prototype.bind;
    const originalBindProfile = AgentLoopService.prototype.bindProfile;
    const worktreesHome = join(fixture.home, 'worktrees');
    let sessionId = '';
    let switching = false;
    let held: Envelope<{ prompt_id: string; status: string }> | undefined;
    vi.spyOn(AgentEnvironmentBindingService.prototype, 'bind').mockImplementation(function (
      this: AgentEnvironmentBindingService,
      ...args: Parameters<AgentEnvironmentBindingService['bind']>
    ) {
      if (args[1]?.startsWith(worktreesHome) === true) switching = true;
      return originalBind.apply(this, args);
    });
    vi.spyOn(AgentLoopService.prototype, 'bindProfile').mockImplementation(async function (
      this: AgentLoopService,
      ...args: Parameters<AgentLoopService['bindProfile']>
    ) {
      if (switching) {
        switching = false;
        await vi.waitFor(() => {
          if (sessionId === '') throw new Error('the session has not been created yet');
        });
        held = await post(`/sessions/${sessionId}/prompts`, { content: [{ type: 'text', text: 'held hello' }] });
      }
      return originalBindProfile.apply(this, args);
    });
    onTestFinished(() => {
      vi.restoreAllMocks();
    });

    sessionId = (await createWorktreeSession(workspaceId)).id;
    await vi.waitFor(() => {
      if (held === undefined) throw new Error('the prompt has not been sent yet');
    });
    expect(held).toMatchObject({ code: 0, data: { status: 'queued' } });

    expect((await settled(sessionId)).worktree?.setup.status).toBe('ready');
    await vi.waitFor(async () => {
      expect((await get<Session>(`/sessions/${sessionId}`)).data.worktree?.held_prompt).toBeUndefined();
      expect(await sentTexts(sessionId)).toContain('held hello');
    });
  });

  it('keeps a held prompt across reloads, refuses a second one, and sends it when the session stays local', async () => {
    const { root, workspaceId } = await project('held-local');
    hangingRemote(root);
    const created = await createWorktreeSession(workspaceId, { use_remote: true });
    await untilStep(created.id, 'fetch', 'running');

    const first = await post<{ prompt_id: string; status: string }>(`/sessions/${created.id}/prompts`, {
      content: [{ type: 'text', text: 'first while waiting' }],
    });
    expect(first).toMatchObject({ code: 0, data: { status: 'queued' } });
    const second = await post(`/sessions/${created.id}/prompts`, {
      content: [{ type: 'text', text: 'second while waiting' }],
    });
    expect(second.code).toBe(ErrorCode.WORKTREE_STATE_INVALID);

    const reloaded = (await get<Session>(`/sessions/${created.id}`)).data;
    expect(reloaded.worktree?.held_prompt).toMatchObject({
      prompt_id: first.data.prompt_id,
      kind: 'prompt',
      content: [{ type: 'text', text: 'first while waiting' }],
    });
    expect(JSON.stringify(reloaded)).not.toContain('held_request');

    expect((await post<Session>(`/sessions/${created.id}/worktree:cancel`)).code).toBe(0);
    expect((await get<Session>(`/sessions/${created.id}`)).data.worktree?.held_prompt?.prompt_id).toBe(
      first.data.prompt_id,
    );
    expect(await sentTexts(created.id)).not.toContain('first while waiting');

    expect((await post<Session>(`/sessions/${created.id}/worktree:use_local`)).code).toBe(0);
    await vi.waitFor(async () => {
      expect((await get<Session>(`/sessions/${created.id}`)).data.worktree?.held_prompt).toBeUndefined();
      expect(await sentTexts(created.id)).toContain('first while waiting');
    });
  });

  it('withdraws a held prompt that is aborted by its id', async () => {
    const { root, workspaceId } = await project('held-abort');
    hangingRemote(root);
    const created = await createWorktreeSession(workspaceId, { use_remote: true });
    await untilStep(created.id, 'fetch', 'running');
    const held = await post<{ prompt_id: string }>(`/sessions/${created.id}/prompts`, {
      content: [{ type: 'text', text: 'never mind' }],
      skills: [{ name: 'update-config' }],
    });
    expect((await get<Session>(`/sessions/${created.id}`)).data.worktree?.held_prompt?.skills).toEqual([
      { name: 'update-config' },
    ]);

    const aborted = await post(`/sessions/${created.id}/prompts/${held.data.prompt_id}:abort`);

    expect(aborted).toMatchObject({ code: 0, data: { aborted: true } });
    expect((await get<Session>(`/sessions/${created.id}`)).data.worktree?.held_prompt).toBeUndefined();
    await post<Session>(`/sessions/${created.id}/worktree:cancel`);
    expect((await post<Session>(`/sessions/${created.id}/worktree:use_local`)).code).toBe(0);
    expect(await sentTexts(created.id)).toEqual([]);
  });

  it('holds a skill activation sent during setup', async () => {
    const { root, workspaceId } = await project('held-skill');
    hangingRemote(root);
    const created = await createWorktreeSession(workspaceId, { use_remote: true });
    await untilStep(created.id, 'fetch', 'running');

    const activated = await post(`/sessions/${created.id}/skills/update-config:activate`, { args: 'now' });

    expect(activated).toMatchObject({ code: 0, data: { activated: true, skill_name: 'update-config', held: true } });
    expect((await get<Session>(`/sessions/${created.id}`)).data.worktree?.held_prompt).toMatchObject({
      kind: 'skill',
      skill: { name: 'update-config', args: 'now' },
    });
    expect((await post<Session>(`/sessions/${created.id}/worktree:cancel`)).code).toBe(0);
  });

  it('marks a held prompt failed when a previous server process may have sent it', async () => {
    const { root, workspaceId } = await project('held-restart');
    hangingRemote(root);
    const created = await createWorktreeSession(workspaceId, { use_remote: true });
    await untilStep(created.id, 'fetch', 'running');
    const held = await post<{ prompt_id: string }>(`/sessions/${created.id}/prompts`, {
      content: [{ type: 'text', text: 'maybe sent' }],
    });
    await post<Session>(`/sessions/${created.id}/worktree:cancel`);
    await patchSessionMetadata(fixture.server.core.accessor, created.id, (meta) => {
      const current = meta.custom?.['worktree'] as { setup: object };
      return { custom: { ...meta.custom, worktree: { ...current, setup: { ...current.setup, status: 'local' } } } };
    });

    await new SessionWorktreeService(fixture.server.core).recoverInterrupted();

    expect((await get<Session>(`/sessions/${created.id}`)).data.worktree?.held_prompt).toMatchObject({
      prompt_id: held.data.prompt_id,
      failure: { code: ErrorCode.INTERNAL_ERROR },
    });
    const next = await post<{ status: string }>(`/sessions/${created.id}/prompts`, {
      content: [{ type: 'text', text: 'sent again' }],
    });
    expect(next.code).toBe(0);
    await vi.waitFor(async () => {
      expect((await get<Session>(`/sessions/${created.id}`)).data.worktree?.held_prompt).toBeUndefined();
    });
  });

  it('rejects worktree requests it cannot serve', async () => {
    const plain = join(fixture.scratch, 'not-a-repo');
    await mkdir(plain, { recursive: true });
    const plainWorkspace = await createWorkspace(plain);
    const unsupported = await post<Session>('/sessions', {
      workspace_id: plainWorkspace,
      worktree: { source_branch: 'main' },
    });
    expect(unsupported.code).toBe(ErrorCode.WORKTREE_UNSUPPORTED);

    const { workspaceId } = await project('rejections');
    const unknownBranch = await post<Session>('/sessions', {
      workspace_id: workspaceId,
      worktree: { source_branch: 'nope' },
    });
    expect(unknownBranch.code).toBe(ErrorCode.VALIDATION_FAILED);

    const local = await post<Session>('/sessions', { workspace_id: workspaceId });
    expect(local.data.worktree).toBeUndefined();
    const noSetup = await post<Session>(`/sessions/${local.data.id}/worktree:cancel`);
    expect(noSetup.code).toBe(ErrorCode.WORKTREE_STATE_INVALID);
    const missing = await post<Session>('/sessions/nope/worktree:cancel');
    expect(missing.code).toBe(ErrorCode.SESSION_NOT_FOUND);

    const ready = await settledWorktree(workspaceId);
    for (const action of ['retry', 'cancel', 'use_local', 'recreate']) {
      const refused = await post<Session>(`/sessions/${ready.id}/worktree:${action}`);
      expect(refused.code, action).toBe(ErrorCode.WORKTREE_STATE_INVALID);
    }
    const profile = await post<{ session: Session }>(`/sessions/${ready.id}/profile`, {
      metadata: { worktree: { setup: { status: 'local' } }, note: 'kept' },
    });
    expect(profile.data.session.metadata).toEqual({ note: 'kept' });
    expect(profile.data.session.worktree).toEqual(ready.worktree);
  });

  it('settles a setup that a previous server process left running', async () => {
    const { root, workspaceId } = await project('interrupted');
    const ready = await settledWorktree(workspaceId);
    const leftoverPath = join(fixture.home, 'worktrees', 'interrupted', 'left-over');
    git(root, 'worktree', 'add', '-q', '-b', 'kimi/left-over', leftoverPath);
    const plain = await post<Session>('/sessions', { workspace_id: workspaceId });
    await forceRunning(
      plain.data.id,
      { ...ready.worktree!.setup, steps: [{ kind: 'create', state: 'running' }] },
      { repo_root: root, pending: { path: leftoverPath, branch: 'kimi/left-over' } },
    );

    await new SessionWorktreeService(fixture.server.core).recoverInterrupted();

    const recovered = await get<Session>(`/sessions/${plain.data.id}`);
    expect(recovered.data.worktree?.setup).toMatchObject({
      status: 'stopped',
      stopped_step: 'create',
      steps: [{ kind: 'create', state: 'stopped' }],
    });
    expect(existsSync(leftoverPath)).toBe(false);
    expect(git(root, 'branch', '--list', 'kimi/left-over')).toBe('');
    expect((await get<Session>(`/sessions/${ready.id}`)).data.worktree?.setup.status).toBe('ready');
    expect((await stored(plain.data.id))?.pending).toBeUndefined();

    await forceRunning(ready.id, ready.worktree!.setup);
    await new SessionWorktreeService(fixture.server.core).recoverInterrupted();
    const resumed = await get<Session>(`/sessions/${ready.id}`);
    expect(resumed.data.worktree?.setup.status).toBe('ready');
    expect(resumed.data.worktree?.path).toBe(ready.worktree!.path);
    expect(existsSync(ready.worktree!.path!)).toBe(true);

    await forceRunning(plain.data.id, {
      ...ready.worktree!.setup,
      purpose: 'recreate',
      steps: [
        { kind: 'prune', state: 'running' },
        { kind: 'create', state: 'pending' },
      ],
    }, { repo_root: root, path: ready.worktree!.path, branch: ready.worktree!.branch, pending: undefined });
    await new SessionWorktreeService(fixture.server.core).recoverInterrupted();
    expect((await get<Session>(`/sessions/${plain.data.id}`)).data.worktree?.setup).toMatchObject({
      status: 'stopped',
      stopped_step: 'prune',
    });
    expect(existsSync(ready.worktree!.path!)).toBe(true);
  });

  it('lists local branches by latest commit with their remote branch and the dirty flag', async () => {
    interface Branches {
      is_repo: boolean;
      head_branch?: string;
      dirty: boolean;
      remotes: string[];
      branches: {
        name: string;
        committed_at: string;
        remote_ref?: string;
        remote?: string;
        remote_source?: 'upstream' | 'same_name';
      }[];
    }
    const plain = join(fixture.scratch, 'branches-plain');
    await mkdir(plain, { recursive: true });
    const plainBranches = await get<Branches>(`/workspaces/${await createWorkspace(plain)}/git/branches`);
    expect(plainBranches.data).toEqual({ is_repo: false, dirty: false, remotes: [], branches: [] });

    const { root, workspaceId } = await project('branches');
    addRemote(root);
    const commitAt = (branch: string, date: string) => {
      git(root, 'checkout', '-q', '-b', branch, 'main');
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', branch], {
        cwd: root,
        env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
      });
    };
    commitAt('older', '2030-01-01T00:00:00Z');
    commitAt('newest', '2031-06-01T12:00:00Z');
    git(root, 'checkout', '-q', 'main');
    await mkdir(join(root, 'nested'));
    const nestedWorkspaceId = await createWorkspace(join(root, 'nested'));

    const clean = await get<Branches>(`/workspaces/${workspaceId}/git/branches`);
    expect(clean.code).toBe(0);
    expect(clean.data).toMatchObject({ is_repo: true, head_branch: 'main', dirty: false, remotes: ['origin'] });
    expect(clean.data.branches.map((branch) => branch.name)).toEqual(['newest', 'older', 'main']);
    expect(clean.data.branches[0]).toEqual({ name: 'newest', committed_at: '2031-06-01T12:00:00.000Z' });
    expect(clean.data.branches[2]).toMatchObject({
      name: 'main',
      remote_ref: 'origin/main',
      remote: 'origin',
      remote_source: 'upstream',
    });

    git(root, 'remote', 'add', 'fork', join(fixture.scratch, 'branches-fork-does-not-exist.git'));
    git(root, 'update-ref', 'refs/remotes/fork/older', 'older');
    const forked = await get<Branches>(`/workspaces/${workspaceId}/git/branches`);
    expect(forked.data.remotes).toEqual(['fork', 'origin']);
    expect(forked.data.branches[1]).toMatchObject({
      name: 'older',
      remote_ref: 'fork/older',
      remote: 'fork',
      remote_source: 'same_name',
    });
    expect(forked.data.branches[0]).not.toHaveProperty('remote');

    await writeFile(join(root, 'untracked.txt'), 'x\n');
    git(root, 'checkout', '-q', '--detach');
    const dirty = await get<Branches>(`/workspaces/${workspaceId}/git/branches`);
    expect(dirty.data.dirty).toBe(true);
    expect(dirty.data).not.toHaveProperty('head_branch');

    const nested = await get<Branches>(`/workspaces/${nestedWorkspaceId}/git/branches`);
    expect(nested.data.is_repo).toBe(false);
    const unknown = await get<Branches>('/workspaces/wd_missing_000000000000/git/branches');
    expect(unknown.code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
  });

  it('recreates a missing worktree from its recorded branch', async () => {
    const { workspaceId } = await project('recreate');
    const session = await settledWorktree(workspaceId);
    const { path, branch } = session.worktree as { path: string; branch: string };
    await writeFile(join(path, 'kept.txt'), 'committed in the worktree\n');
    commitAll(path, 'work');
    await rm(path, { recursive: true, force: true });
    await closeSessionById(fixture.server.core.accessor, session.id);

    const missing = await get<Session>(`/sessions/${session.id}`);
    expect(missing.data.worktree).toMatchObject({ path, branch, missing: true });
    expect(missing.data.worktree?.branch_missing).toBeUndefined();
    expect((await get<{ turns: unknown[] }>(`/sessions/${session.id}/agents/main/turns`)).code).toBe(0);
    expect((await post(`/sessions/${session.id}/fs:git_status`, {})).code).toBe(
      ErrorCode.FS_DIRECTORY_NOT_FOUND,
    );

    const [started, again] = await Promise.all([
      post<Session>(`/sessions/${session.id}/worktree:recreate`),
      post<Session>(`/sessions/${session.id}/worktree:recreate`),
    ]);
    expect(started.code).toBe(0);
    expect(again.code).toBe(ErrorCode.WORKTREE_STATE_INVALID);
    expect(started.data.worktree?.setup).toMatchObject({ status: 'running', purpose: 'recreate' });
    expect(started.data.worktree?.setup.steps).toMatchObject([
      { kind: 'prune', command: 'git worktree prune' },
      { kind: 'create', ref: branch, command: `git worktree add ${path} ${branch}` },
    ]);
    const ready = await settled(session.id);

    expect(ready.worktree?.setup).toMatchObject({ status: 'ready', purpose: 'recreate', commands_ran: 2 });
    expect(ready.worktree?.setup.steps.map((step) => step.state)).toEqual(['done', 'done']);
    expect(ready.worktree?.missing).toBeUndefined();
    expect(ready.worktree?.path).toBe(path);
    expect(ready.cwd).toBe(path);
    expect(await readFile(join(path, 'kept.txt'), 'utf-8')).toBe('committed in the worktree\n');
    expect(await branchOf(session.id)).toBe(branch);
  });

  it('falls back to the workspace root when a missing worktree cannot be recreated', async () => {
    const { root, workspaceId } = await project('recreate-failure');
    const session = await settledWorktree(workspaceId);
    const { path, branch } = session.worktree as { path: string; branch: string };
    await rm(path, { recursive: true, force: true });
    git(root, 'worktree', 'prune');
    git(root, 'branch', '-D', branch);

    const missing = await get<Session>(`/sessions/${session.id}`);
    expect(missing.data.worktree).toMatchObject({ missing: true, branch_missing: true });
    await post<Session>(`/sessions/${session.id}/worktree:recreate`);
    const failed = await settled(session.id);

    expect(failed.worktree?.setup).toMatchObject({
      status: 'failed',
      purpose: 'recreate',
      stopped_step: 'create',
      failure: { kind: 'create_failed' },
    });
    expect(failed.worktree?.setup.steps[1]?.output).toMatch(/invalid reference|not a valid|fatal/);
    expect(failed.worktree?.path).toBe(path);
    expect(existsSync(path)).toBe(false);
    const retried = await post<Session>(`/sessions/${session.id}/worktree:retry`);
    expect(retried.data.worktree?.setup).toMatchObject({ status: 'running', purpose: 'recreate' });
    await settled(session.id);

    const local = await post<Session>(`/sessions/${session.id}/worktree:use_local`);

    expect(local.code).toBe(0);
    expect(local.data.cwd).toBe(root);
    expect(local.data.worktree?.setup.status).toBe('local');
    expect(local.data.worktree?.path).toBeUndefined();
    expect(local.data.worktree?.branch).toBeUndefined();
    expect(local.data.worktree?.missing).toBeUndefined();
    const agent = agentState(session.id);
    expect(agent).toMatchObject({ cwd: undefined, workDir: root });
    expect(agent.prompt).not.toContain(path);
    expect(await branchOf(session.id)).toBe('main');
  });
});

describe('server-v2 session worktrees with a remote default environment', () => {
  const { project, createWorktreeSession, settled } = useWorktreeServer('worktrees-remote-default', {
    extraConfig: ['[environments]', 'default = "far"', '', '[environments.far]', 'command = "/bin/false"', 'defaultCwd = "/tmp"', ''].join('\n'),
  });

  it('creates the worktree session in the local environment', async () => {
    const { workspaceId } = await project('remote-default');

    const created = await createWorktreeSession(workspaceId);
    expect(created.environment_id).toBe('local');
    const ready = await settled(created.id);

    expect(ready.worktree?.setup.status).toBe('ready');
    expect(ready.environment_id).toBe('local');
    expect(ready.cwd).toBe(ready.worktree?.path);
  });
});
