import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import type {
  CreateWorktreeRequest,
  FsPullRequest,
  RemoveWorktreeRequest,
  Worktree,
} from '@moonshot-ai/protocol';
import { IEventService } from '../event/event';
import { parsePorcelain } from '../fs/fsGit';
import { ISessionService } from '../session/session';
import { IWorkspaceRegistry } from '../workspace/workspaceRegistry';

import {
  IWorktreeService,
  WorktreeConflictError,
  WorktreeError,
  WorktreeGitUnavailableError,
  WorktreeNotFoundError,
} from './worktree';

const PR_SPAWN_TIMEOUT_MS = 5_000;
const PULL_REQUEST_TTL_MS = 60_000;
const GIT_SPAWN_TIMEOUT_MS = 15_000;

interface RawWorktree {
  readonly path: string;
  readonly head: string;
  readonly branch: string;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
  readonly isMain: boolean;
}

export class WorktreeService extends Disposable implements IWorktreeService {
  readonly _serviceBrand: undefined;

  private readonly pullRequestCache = new Map<
    string,
    { value: FsPullRequest | null; fetchedAt: number }
  >();

  constructor(
    @IWorkspaceRegistry private readonly workspaces: IWorkspaceRegistry,
    @ISessionService private readonly sessions: ISessionService,
    @IEventService private readonly eventService: IEventService,
  ) {
    super();
  }

  async list(workspaceId: string): Promise<Worktree[]> {
    const root = await this.workspaces.resolveRoot(workspaceId);
    await this.assertGitRepo(root);
    const realRoot = await this.requireRealRoot(root);
    const rawList = await this.listRaw(root);
    const sessionMap = await this.buildSessionMap();
    return Promise.all(
      rawList.map((raw) => this.enrich(raw, realRoot, sessionMap)),
    );
  }

  async create(workspaceId: string, req: CreateWorktreeRequest): Promise<Worktree> {
    const root = await this.workspaces.resolveRoot(workspaceId);
    await this.assertGitRepo(root);
    const realRoot = await this.requireRealRoot(root);

    const branch = req.branch?.trim() || defaultBranchName();
    validateBranchName(branch);

    const targetPath = await this.resolveTargetPath(realRoot, branch, req.path);
    const base = req.base_ref?.trim() || (await this.resolveBase(realRoot));

    const res = await runCommand(
      'git',
      ['worktree', 'add', '-b', branch, targetPath, base],
      realRoot,
      { timeoutMs: GIT_SPAWN_TIMEOUT_MS },
    );
    if (res.exitCode !== 0) {
      throw new WorktreeConflictError(
        res.stderr.trim() || `git worktree add exit ${res.exitCode}`,
      );
    }

    this.publish(workspaceId, targetPath, 'created');

    // Re-read the just-created worktree. A brand-new worktree has no session
    // yet, so session correlation is intentionally skipped (empty map).
    const rawList = await this.listRaw(realRoot);
    const created = rawList.find((w) => path.resolve(w.path) === targetPath);
    if (created === undefined) {
      throw new WorktreeError(`worktree created but not listed: ${targetPath}`);
    }
    return this.enrich(created, realRoot, new Map());
  }

  async remove(workspaceId: string, req: RemoveWorktreeRequest): Promise<void> {
    const root = await this.workspaces.resolveRoot(workspaceId);
    const realRoot = await this.requireRealRoot(root);
    const targetPath = path.resolve(req.path);

    const rawList = await this.listRaw(realRoot);
    const match = rawList.find((w) => path.resolve(w.path) === targetPath);
    if (match === undefined) {
      throw new WorktreeNotFoundError(req.path);
    }
    if (match.isMain) {
      throw new WorktreeConflictError('cannot remove the main worktree');
    }

    const args = ['worktree', 'remove'];
    if (req.force === true) args.push('--force');
    args.push(targetPath);
    const res = await runCommand('git', args, realRoot, {
      timeoutMs: GIT_SPAWN_TIMEOUT_MS,
    });
    if (res.exitCode !== 0) {
      throw new WorktreeConflictError(
        res.stderr.trim() || `git worktree remove exit ${res.exitCode}`,
      );
    }

    if (req.delete_branch === true && match.branch.length > 0) {
      // Best-effort: the branch may legitimately be gone already; ignore errors.
      await runCommand('git', ['branch', '-D', match.branch], realRoot, {
        timeoutMs: GIT_SPAWN_TIMEOUT_MS,
      });
    }

    this.publish(workspaceId, targetPath, 'removed');
  }

  private async assertGitRepo(root: string): Promise<void> {
    const res = await runCommand(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      root,
      { timeoutMs: GIT_SPAWN_TIMEOUT_MS },
    );
    if (res.exitCode !== 0 || res.stdout.trim() !== 'true') {
      throw new WorktreeGitUnavailableError(
        root,
        res.stderr.trim() || `git rev-parse exit ${res.exitCode}`,
      );
    }
  }

  private async requireRealRoot(root: string): Promise<string> {
    const rp = await realpathSafe(root);
    if (rp === null) {
      throw new WorktreeError(`workspace root does not exist: ${root}`);
    }
    return rp;
  }

  private async listRaw(root: string): Promise<RawWorktree[]> {
    const res = await runCommand(
      'git',
      ['worktree', 'list', '--porcelain'],
      root,
      { timeoutMs: GIT_SPAWN_TIMEOUT_MS },
    );
    if (res.exitCode !== 0) {
      throw new WorktreeGitUnavailableError(
        root,
        res.stderr.trim() || `git worktree list exit ${res.exitCode}`,
      );
    }
    return parseWorktreeList(res.stdout);
  }

  private async enrich(
    raw: RawWorktree,
    realRoot: string,
    sessionMap: Map<string, string>,
  ): Promise<Worktree> {
    const realPath = (await realpathSafe(raw.path)) ?? path.resolve(raw.path);

    let dirty = false;
    let ahead = 0;
    let behind = 0;
    if (!raw.prunable) {
      const statusRes = await runCommand(
        'git',
        ['status', '--porcelain=v1', '--branch'],
        realPath,
        { timeoutMs: GIT_SPAWN_TIMEOUT_MS },
      );
      if (statusRes.exitCode === 0) {
        const parsed = parsePorcelain(statusRes.stdout, undefined);
        ahead = parsed.ahead;
        behind = parsed.behind;
        dirty = Object.keys(parsed.entries).length > 0;
      }
    }

    const pullRequest = raw.prunable ? null : await this.readPullRequest(realPath);
    const sessionId = matchSession(realPath, sessionMap);

    return {
      path: raw.path,
      branch: raw.branch,
      head: raw.head,
      is_main: realPath === realRoot,
      locked: raw.locked,
      prunable: raw.prunable,
      dirty,
      ahead,
      behind,
      session_id: sessionId,
      pull_request: pullRequest,
    };
  }

  private async resolveBase(realRoot: string): Promise<string> {
    const res = await runCommand(
      'git',
      ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      realRoot,
      { timeoutMs: GIT_SPAWN_TIMEOUT_MS },
    );
    const ref = res.stdout.trim();
    if (res.exitCode === 0 && ref.length > 0) {
      // e.g. "refs/remotes/origin/main" → "origin/main", a valid start point
      // for `git worktree add -b <branch> <path> <base>`.
      return ref.replace(/^refs\/remotes\//, '');
    }
    return 'HEAD';
  }

  private async resolveTargetPath(
    realRoot: string,
    branch: string,
    customPath: string | undefined,
  ): Promise<string> {
    if (customPath !== undefined && customPath.trim().length > 0) {
      const resolved = path.resolve(customPath.trim());
      assertInsideRoot(resolved, realRoot);
      await assertNotExists(resolved);
      return resolved;
    }

    const base = path.join(realRoot, '.worktrees', slugify(branch));
    let candidate = base;
    for (let i = 2; i <= 20; i++) {
      if (!(await pathExists(candidate))) return candidate;
      candidate = `${base}-${i}`;
    }
    throw new WorktreeConflictError(
      `worktree path already exists: ${base} (and numbered suffixes)`,
    );
  }

  private async buildSessionMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let afterId: string | undefined;
    for (;;) {
      const page = await this.sessions.list(
        afterId === undefined ? { page_size: 100 } : { page_size: 100, after_id: afterId },
      );
      for (const s of page.items) {
        const cwd = s.metadata?.cwd;
        if (typeof cwd === 'string' && cwd.length > 0) {
          const rp = await realpathSafe(cwd);
          if (rp !== null && !map.has(rp)) map.set(rp, s.id);
        }
      }
      if (!page.has_more || page.items.length === 0) break;
      afterId = page.items[page.items.length - 1]?.id;
      if (afterId === undefined) break;
    }
    return map;
  }

  private async readPullRequest(cwd: string): Promise<FsPullRequest | null> {
    const cached = this.pullRequestCache.get(cwd);
    const now = Date.now();
    if (cached !== undefined && now - cached.fetchedAt < PULL_REQUEST_TTL_MS) {
      return cached.value;
    }
    const res = await runCommand(
      'gh',
      ['pr', 'view', '--json', 'number,url,state'],
      cwd,
      {
        timeoutMs: PR_SPAWN_TIMEOUT_MS,
        env: { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' },
      },
    );
    const value = res.exitCode === 0 ? parsePullRequest(res.stdout) : null;
    this.pullRequestCache.set(cwd, { value, fetchedAt: now });
    return value;
  }

  private publish(
    workspaceId: string,
    worktreePath: string,
    change: 'created' | 'removed',
  ): void {
    this.eventService.publish({
      agentId: 'main',
      sessionId: '__global__',
      type: 'event.worktree.changed',
      workspace_id: workspaceId,
      path: worktreePath,
      change,
    });
  }
}

function matchSession(realPath: string, sessionMap: Map<string, string>): string | null {
  const exact = sessionMap.get(realPath);
  if (exact !== undefined) return exact;
  const prefix = realPath.endsWith(path.sep) ? realPath : realPath + path.sep;
  for (const [cwd, id] of sessionMap) {
    if (cwd.startsWith(prefix)) return id;
  }
  return null;
}

function parseWorktreeList(stdout: string): RawWorktree[] {
  const result: RawWorktree[] = [];
  for (const block of stdout.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    let worktreePath = '';
    let head = '';
    let branch = '';
    let bare = false;
    let locked = false;
    let prunable = false;
    let detached = false;
    for (const line of lines) {
      if (line.startsWith('worktree ')) worktreePath = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim();
      else if (line === 'bare') bare = true;
      else if (line === 'detached') detached = true;
      else if (line.startsWith('locked')) locked = true;
      else if (line.startsWith('prunable')) prunable = true;
    }
    if (worktreePath.length === 0) continue;
    if (branch.startsWith('refs/heads/')) branch = branch.slice('refs/heads/'.length);
    if (detached) branch = '';
    result.push({
      path: worktreePath,
      head,
      branch,
      bare,
      locked,
      prunable,
      isMain: result.length === 0,
    });
  }
  return result;
}

function validateBranchName(branch: string): void {
  if (branch.length === 0 || branch.length > 200) {
    throw new WorktreeError('invalid branch name length');
  }
  if (/\s/.test(branch) || branch.includes('..') || branch.startsWith('-')) {
    throw new WorktreeError(`invalid branch name: ${branch}`);
  }
}

function defaultBranchName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `worktree/${stamp}`;
}

function slugify(branch: string): string {
  return branch.replaceAll(/[^A-Za-z0-9._-]+/g, '-').replaceAll(/^-+|-+$/g, '').slice(0, 80) || 'worktree';
}

function assertInsideRoot(target: string, realRoot: string): void {
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (target !== realRoot && !target.startsWith(prefix)) {
    throw new WorktreeError(`worktree path escapes repository root: ${target}`);
  }
}

async function assertNotExists(p: string): Promise<void> {
  if (await pathExists(p)) {
    throw new WorktreeConflictError(`path already exists: ${p}`);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function realpathSafe(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunCommandOptions {
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

async function runCommand(
  cmd: string,
  args: readonly string[],
  cwd: string,
  options: RunCommandOptions = {},
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill();
        finish({ exitCode: -1, stdout, stderr });
      }, options.timeoutMs);
      timer.unref?.();
    }
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.once('error', () => {
      finish({ exitCode: -1, stdout, stderr });
    });
    child.once('close', (code) => {
      finish({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function parsePullRequest(stdout: string): FsPullRequest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const number = record['number'];
  const url = record['url'];
  const state = record['state'];
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
  if (typeof url !== 'string' || !isSafeHttpUrl(url)) return null;
  if (typeof state !== 'string') return null;
  const normalized = state.toLowerCase();
  if (normalized !== 'open' && normalized !== 'merged' && normalized !== 'closed') return null;
  return { number, state: normalized, url };
}

function isSafeHttpUrl(value: string): boolean {
  if (hasControlChars(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

registerSingleton(IWorktreeService, WorktreeService, InstantiationType.Delayed);
