import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { logSeed, resolveLoggingConfig } from '#/_base/log/logConfig';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { IProjectPermissionRulesService } from '#/agent/permissionRules/projectPermissionRules';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import type { CreateManagedSessionOptions } from '#/app/sessionManager/sessionManager';
import { SESSION_PRESENCE_DIR } from '#/app/sessionPresence/sessionPresence';
import { ISessionManager, IWorkspaceService, bootstrap } from '#/index';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';
import { IWorkspaceTrustStore } from '#/workspace/workspaceTrust/workspaceTrustStore';

import { cwdStdioFixture } from '../../mcpCore/stubs';

const clientIdentity = { productName: 'worktree-session-test', version: '0.0.0', platform: 'test' };

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

interface WorktreePaths {
  readonly repo: string;
  readonly wt: string;
  readonly link: string;
}

describe('sessions in a Kimi worktree', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  async function openAndCloseWorktreeSession(
    worktreeFlag: boolean,
    createIn: (paths: WorktreePaths) => CreateManagedSessionOptions = ({ repo, wt }) => ({
      workDir: repo,
      environmentId: 'local',
      environmentCwd: wt,
    }),
  ) {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-session-')));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    const extra = join(root, 'extra');
    mkdirSync(extra, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
    git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
    mkdirSync(join(repo, '.kimi-code'), { recursive: true });
    writeFileSync(join(repo, '.kimi-code', 'local.toml'), '[[permission.rules]]\ndecision = "allow"\npattern = "Bash(pwd)"\n');
    const parent = join(home, 'worktrees', encodeWorkDirKey(repo));
    const wt = join(parent, 'x');
    mkdirSync(parent, { recursive: true });
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    const link = join(root, 'wt-link');
    symlinkSync(wt, link);

    const env = { KIMI_CODE_EXPERIMENTAL_WORKTREE: worktreeFlag ? '1' : '0' };
    const boot = () =>
      bootstrap(
        { homeDir: home, env, clientIdentity },
        logSeed(resolveLoggingConfig({ homeDir: home, env: { ...env, KIMI_LOG_LEVEL: 'off' } })),
      ).app;

    const app = boot();
    await app.accessor.get(IWorkspaceTrustStore).forRoot(repo).trust();
    const workspaces = app.accessor.get(IWorkspaceService);
    const project = await workspaces.createOrTouch(repo);
    await workspaces.update(project.id, { additionalDirs: [extra] });
    const sessions = app.accessor.get(ISessionManager);
    const handle = await sessions.create(createIn({ repo, wt, link }));
    const ctx = handle.accessor.get(ISessionContext);
    const rules = handle.accessor.get(IProjectPermissionRulesService);
    await rules.ready;
    const appended = await handle.accessor
      .get(IProjectLocalConfigService)
      .appendPermissionRules(ctx.cwd, [{ decision: 'deny', pattern: 'Bash(rm)' }]);
    const markers = join(ctx.sessionDir, SESSION_PRESENCE_DIR);
    const listMarkers = (): string[] => (existsSync(markers) ? readdirSync(markers) : []);
    const observed = {
      cwd: ctx.cwd,
      rules: JSON.stringify(rules.rules),
      additionalDirs: handle.accessor.get(ISessionWorkspaceInfo).additionalDirs,
      appendedTo: appended.configPath,
      markersWhileOpen: listMarkers().length,
    };
    await sessions.close(handle.id);
    await vi.waitFor(() => expect(listMarkers()).toEqual([]), { timeout: 5000 });
    app.dispose();

    const restarted = boot();
    const roots = (await restarted.accessor.get(IWorkspaceService).list()).map((workspace) => workspace.root);
    restarted.dispose();
    return { ...observed, roots, repo, wt, extra };
  }

  it('keeps project local config, remembered dirs and the project list on the source project', async () => {
    const observed = await openAndCloseWorktreeSession(true);

    expect(observed.cwd).toBe(observed.wt);
    expect(observed.rules).toContain('Bash(pwd)');
    expect(observed.appendedTo).toBe(join(observed.repo, '.kimi-code', 'local.toml'));
    expect(observed.additionalDirs).toContain(observed.extra);
    expect(observed.additionalDirs).not.toContain(observed.repo);
    expect(observed.markersWhileOpen).toBe(1);
    expect(observed.roots).toContain(observed.repo);
    expect(observed.roots).not.toContain(observed.wt);
  }, 60_000);

  it('keeps the previous behavior while the worktree flag is off', async () => {
    const observed = await openAndCloseWorktreeSession(false);

    expect(observed.cwd).toBe(observed.wt);
    expect(observed.rules).not.toContain('Bash(pwd)');
    expect(observed.appendedTo).toBe(join(observed.wt, '.kimi-code', 'local.toml'));
    expect(observed.additionalDirs).not.toContain(observed.extra);
    expect(observed.markersWhileOpen).toBe(0);
    expect(observed.roots).toContain(observed.wt);
  }, 60_000);

  it.each([
    ['created with the worktree as its project directory', ({ wt }: WorktreePaths) => ({ workDir: wt })],
    [
      'reached through a symlink to the worktree',
      ({ repo, link }: WorktreePaths) => ({ workDir: repo, environmentId: 'local', environmentCwd: `${link}/` }),
    ],
  ])('keeps a session %s on the source project', async (_, createIn) => {
    const observed = await openAndCloseWorktreeSession(true, createIn);

    expect(observed.cwd).toBe(observed.wt);
    expect(observed.rules).toContain('Bash(pwd)');
    expect(observed.appendedTo).toBe(join(observed.repo, '.kimi-code', 'local.toml'));
    expect(observed.additionalDirs).toContain(observed.extra);
    expect(observed.roots).toEqual([observed.repo]);
  }, 60_000);

  it('runs one MCP set for the sessions in one worktree directory however its path is spelled', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-session-')));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
    mkdirSync(join(repo, 'a'));
    writeFileSync(join(repo, 'a', '.gitkeep'), '');
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { command: process.execPath, args: [cwdStdioFixture] } } }));
    git(repo, 'add', '.');
    git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    const wt = join(home, 'worktrees', encodeWorkDirKey(repo), 'x');
    mkdirSync(join(home, 'worktrees', encodeWorkDirKey(repo)), { recursive: true });
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    const env = { KIMI_CODE_EXPERIMENTAL_WORKTREE: '1' };
    const app = bootstrap(
      { homeDir: home, env, clientIdentity },
      logSeed(resolveLoggingConfig({ homeDir: home, env: { ...env, KIMI_LOG_LEVEL: 'off' } })),
    ).app;
    await app.accessor.get(IWorkspaceTrustStore).forRoot(repo).trust();
    await app.accessor.get(IWorkspaceService).createOrTouch(repo);
    const sessions = app.accessor.get(ISessionManager);
    const open = async (cwd: string) => {
      const handle = await sessions.create({ workDir: repo, environmentId: 'local', environmentCwd: cwd });
      const mcp = handle.accessor.get(ISessionMcpHandle);
      await mcp.ready;
      return { id: handle.id, client: mcp.connectionManager.resolved('shared')?.client };
    };
    const opened = [await open(join(wt, 'a')), await open(`${wt}/a/.`), await open(`${wt}/a/`)];
    try {
      expect(opened[0]?.client).toBeDefined();
      for (const session of opened) expect(session.client).toBe(opened[0]?.client);
    } finally {
      for (const session of opened) await sessions.close(session.id);
      app.dispose();
    }
  }, 60_000);
});
