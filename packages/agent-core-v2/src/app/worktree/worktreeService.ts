import { readlink } from 'node:fs/promises';

import { basename, dirname, isAbsolute, join, relative, resolve } from 'pathe';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { sameDir } from '#/_base/utils/workdir-slug';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEnvironmentService } from '#/app/environment/environment';
import { IFlagService } from '#/app/flag/flag';
import { IProjectService } from '#/app/project/project';
import { LifecycleScope } from '#/app/scopes';
import { ISessionPresence } from '#/app/sessionPresence/sessionPresence';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { resolveProgramPath } from '#/environment/programPath';
import { Error2, ErrorCodes } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcess } from '#/os/interface/hostProcess';

import {
  IWorktreeService,
  WORKTREE_FLAG_ID,
  type CreateWorktreeInput,
  type CreateWorktreeOptions,
  type CreatedWorktree,
  type InspectWorktreeRemovalInput,
  type KimiWorktree,
  type RemoveWorktreeInput,
  type RunSetupScriptInput,
  type RunSetupScriptOptions,
  type WorktreeCheckout,
  type WorktreeCreateEvent,
  type WorktreeListing,
  type WorktreeLocation,
  type WorktreeRemovalCheck,
} from './worktree';
import { WORKTREE_FLAG_ENV } from './flag';
import { canonicalPath, resolveWorktreeCheckout, worktreesDirFor } from './worktreeCheckout';
import { copyIncludedFiles } from './worktreeInclude';
import { generateWorktreeName, normalizeWorktreeName } from './worktreeName';
import {
  countStatusEntries,
  hiddenIndexEntries,
  parseWorktreeList,
  splitNul,
  type PorcelainWorktree,
} from './worktreePorcelain';

const GIT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 2_000;
const OUTPUT_GRACE_MS = 1_000;
const MAX_NAME_ATTEMPTS = 20;
const INCLUDE_FILE = '.worktreeinclude';
const SETUP_SCRIPT = '.kimi-code/worktree-setup.sh';

interface Repository {
  readonly root: string;
  readonly bare: boolean;
  readonly entries: readonly PorcelainWorktree[];
}

interface KimiEntry {
  readonly entry: PorcelainWorktree;
  readonly worktree: KimiWorktree;
}

interface CreationPlan {
  readonly repoRoot: string;
  readonly sourceRoot: string;
  readonly cwd: string;
  readonly name: string;
  readonly path: string;
  readonly commit: string;
  readonly branch: string | undefined;
  readonly sourceDirty: boolean;
}

interface RunOptions {
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onOutput?: (text: string) => void;
}

interface GitOptions {
  readonly stdin?: string;
  readonly signal?: AbortSignal;
  readonly onOutput?: (text: string) => void;
  readonly untimed?: boolean;
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class WorktreeService implements IWorktreeService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEnvironmentService private readonly environments: IEnvironmentService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFlagService private readonly flags: IFlagService,
    @IProjectService private readonly projects: IProjectService,
    @ISessionPresence private readonly presence: ISessionPresence,
  ) {}

  resolveCheckout(cwd: string): Promise<WorktreeCheckout | undefined> {
    return resolveWorktreeCheckout(this.fs, this.bootstrap.homeDir, cwd);
  }

  async locate(cwd: string): Promise<WorktreeLocation> {
    const [checkout, projectRoot] = await Promise.all([
      this.resolveCheckout(cwd),
      this.projects.peekImplicit(cwd).then((project) => project.root, () => cwd),
    ]);
    if (!this.flags.enabled(WORKTREE_FLAG_ID) || checkout?.kind !== 'managed') {
      return { cwd, projectRoot, isGitRepo: checkout !== undefined };
    }
    return {
      cwd: join(checkout.checkoutRoot, checkout.relativePath),
      projectRoot,
      isGitRepo: true,
      worktree: {
        root: checkout.checkoutRoot,
        name: basename(checkout.checkoutRoot),
        repoRoot: checkout.repoRoot,
      },
    };
  }

  worktreesDir(repoRoot: string): string {
    return worktreesDirFor(this.bootstrap.homeDir, repoRoot);
  }

  async list(cwd: string): Promise<WorktreeListing> {
    const checkout = await this.resolveCheckout(cwd);
    if (checkout === undefined) throw notGitRepo(cwd);
    const repo = await this.readRepository(checkout.checkoutRoot, checkout.repoRoot);
    const worktrees = (await this.kimiEntries(repo))
      .map(({ worktree }) => worktree)
      .toSorted((a, b) => a.name.localeCompare(b.name));
    return { repoRoot: repo.root, bare: repo.bare, worktrees };
  }

  async create(input: CreateWorktreeInput, options: CreateWorktreeOptions = {}): Promise<CreatedWorktree> {
    const { signal } = options;
    const emit = (event: WorktreeCreateEvent): void => options.onEvent?.(event);

    emit({ type: 'step', step: 'check', status: 'started' });
    const plan = await this.planCreation(input, signal);
    emit({ type: 'step', step: 'check', status: 'finished' });
    emit({ type: 'planned', name: plan.name, path: plan.path, head: plan.commit });

    emit({ type: 'step', step: 'add', status: 'started' });
    throwIfCancelled(signal);
    await this.claimDirectory(plan.path);
    let copiedFiles: readonly string[];
    let branchCreated = false;
    try {
      await this.addWorktree(plan, signal, (text) => {
        emit({ type: 'output', step: 'add', text });
      });
      if (plan.branch !== undefined) {
        await this.attachNewBranch(plan, signal);
        branchCreated = true;
      }
      emit({ type: 'step', step: 'add', status: 'finished' });

      emit({ type: 'step', step: 'include', status: 'started' });
      copiedFiles = await this.copyIncludes(plan, signal);
      throwIfCancelled(signal);
      emit({ type: 'step', step: 'include', status: 'finished' });
    } catch (error) {
      await this.discardWorktree(plan, branchCreated).catch(() => {});
      throw error;
    }

    const relativeCwd = relative(plan.sourceRoot, plan.cwd);
    const mappedCwd = isOutsideRoot(relativeCwd) ? plan.path : join(plan.path, relativeCwd);
    const cwdFallback = !(await this.isDirectory(mappedCwd));
    const setupScript = join(plan.sourceRoot, SETUP_SCRIPT);
    return {
      worktree: { path: plan.path, name: plan.name, head: plan.commit, branch: plan.branch, missing: false },
      repoRoot: plan.repoRoot,
      sourceRoot: plan.sourceRoot,
      cwd: cwdFallback ? plan.path : mappedCwd,
      cwdFallback,
      copiedFiles,
      sourceDirty: plan.sourceDirty,
      setupScript: (await this.isFile(setupScript)) ? setupScript : undefined,
    };
  }

  async runSetupScript(
    input: RunSetupScriptInput,
    options: RunSetupScriptOptions = {},
  ): Promise<{ readonly exitCode: number }> {
    this.requireEnabled();
    const shell = localProgram('bash', input.worktreePath) ?? localProgram('sh', input.worktreePath);
    if (shell === undefined) {
      throw new Error2(ErrorCodes.SHELL_GIT_BASH_NOT_FOUND, 'Running the worktree setup script needs bash or sh on PATH.');
    }
    const result = await this.run(shell, [join(input.sourceRoot, SETUP_SCRIPT)], {
      cwd: input.worktreePath,
      env: {
        KIMI_CODE_WORKTREE_SOURCE_DIR: input.sourceRoot,
        KIMI_CODE_WORKTREE_DIR: input.worktreePath,
      },
      signal: options.signal,
      onOutput: options.onOutput,
    });
    return { exitCode: result.exitCode };
  }

  async inspectRemoval(input: InspectWorktreeRemovalInput): Promise<WorktreeRemovalCheck> {
    const repo = await this.readRepository(input.repoRoot, input.repoRoot);
    const target = await this.findKimiEntry(repo, input.path);
    return this.measureRemoval(repo, target, input.deleteBranch, input.excludeSessionId);
  }

  async remove(input: RemoveWorktreeInput): Promise<void> {
    this.requireEnabled();
    const repo = await this.readRepository(input.repoRoot, input.repoRoot);
    const target = await this.findKimiEntry(repo, input.path);
    const check = await this.measureRemoval(repo, target, input.deleteBranch, input.excludeSessionId);
    if (check.openSessionIds.length > 0) {
      throw new Error2(
        ErrorCodes.WORKTREE_IN_USE,
        `The worktree at ${check.path} is open in ${check.openSessionIds.length} other session(s).`,
        { details: { path: check.path, openSessionIds: check.openSessionIds } },
      );
    }
    const allowed = input.discard === 'all' ? check : validateDiscardLimits(input.discard);
    if (check.uncommittedFiles > allowed.uncommittedFiles) {
      throw new Error2(
        ErrorCodes.WORKTREE_HAS_UNCOMMITTED,
        `The worktree at ${check.path} has ${check.uncommittedFiles} uncommitted file(s).`,
        { details: { path: check.path, uncommittedFiles: check.uncommittedFiles } },
      );
    }
    if (check.uniqueCommits > allowed.uniqueCommits) {
      throw new Error2(
        ErrorCodes.WORKTREE_HAS_UNIQUE_COMMITS,
        `The worktree at ${check.path} has ${check.uniqueCommits} commit(s) that exist nowhere else.`,
        { details: { path: check.path, uniqueCommits: check.uniqueCommits } },
      );
    }

    const forceArgs = check.missing || check.uncommittedFiles > 0 ? ['--force'] : [];
    const removed = await this.git(['worktree', 'remove', ...forceArgs, check.path], repo.root);
    if (removed.exitCode !== 0) throw gitFailed(`Could not remove the worktree at ${check.path}.`, removed);
    if (input.deleteBranch && check.branch !== undefined && target.worktree.head !== undefined) {
      const deleted = await this.git(
        ['update-ref', '-d', `refs/heads/${check.branch}`, target.worktree.head],
        repo.root,
      );
      if (deleted.exitCode !== 0) throw gitFailed(`Could not delete branch ${check.branch}.`, deleted);
    }
  }

  private requireEnabled(): void {
    if (!this.flags.enabled(WORKTREE_FLAG_ID)) {
      throw new Error2(
        ErrorCodes.WORKTREE_DISABLED,
        `Worktrees are experimental; set ${WORKTREE_FLAG_ENV}=1 or enable "${WORKTREE_FLAG_ID}" under [experimental] in config.toml.`,
        { details: { flag: WORKTREE_FLAG_ID, env: WORKTREE_FLAG_ENV } },
      );
    }
  }

  private async planCreation(input: CreateWorktreeInput, signal: AbortSignal | undefined): Promise<CreationPlan> {
    this.requireEnabled();
    const checkout = await this.resolveCheckout(input.cwd);
    if (checkout === undefined) throw notGitRepo(input.cwd);
    const repo = await this.readRepository(checkout.checkoutRoot, checkout.repoRoot, signal);
    const sourceRoot = checkout.checkoutRoot;
    const commit = await this.resolveCommit(sourceRoot, nonEmpty(input.base), signal);
    const requestedName = nonEmpty(input.name);
    const explicitName = requestedName === undefined ? undefined : normalizeWorktreeName(requestedName);

    const worktreesDir = this.worktreesDir(repo.root);
    await this.fs.mkdir(worktreesDir, { recursive: true });
    const parent = await canonicalPath(this.fs, worktreesDir);
    const registered = new Set((await this.kimiEntries(repo)).map(({ worktree }) => worktree.name));
    const taken = async (candidate: string): Promise<boolean> =>
      registered.has(candidate) || (await this.exists(join(parent, candidate)));
    let name = explicitName ?? generateWorktreeName();
    if (explicitName === undefined) {
      for (let attempt = 1; attempt < MAX_NAME_ATTEMPTS && (await taken(name)); attempt++) name = generateWorktreeName();
    }
    const path = join(parent, name);
    if (await taken(name)) throw alreadyExists(path);

    const branch = nonEmpty(input.branch);
    const status = await this.git(['status', '--porcelain=v1', '-z'], sourceRoot, { signal });
    if (status.exitCode !== 0) throw gitFailed(`Could not read the status of ${sourceRoot}.`, status);
    return {
      repoRoot: repo.root,
      sourceRoot,
      cwd: await canonicalPath(this.fs, input.cwd),
      name,
      path,
      commit,
      branch,
      sourceDirty: status.stdout !== '',
    };
  }

  private async resolveCommit(
    sourceRoot: string,
    base: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const rev = base ?? 'HEAD';
    const resolved = rev.startsWith('-')
      ? undefined
      : await this.git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], sourceRoot, { signal });
    if (resolved?.exitCode === 0) return resolved.stdout.trim();
    if (base === undefined) {
      throw new Error2(
        ErrorCodes.WORKTREE_NO_COMMITS,
        `HEAD of ${sourceRoot} does not point to a commit yet; make a first commit or pick another starting point.`,
        { details: { cwd: sourceRoot } },
      );
    }
    throw new Error2(ErrorCodes.WORKTREE_BASE_NOT_FOUND, `"${base}" is not a commit, branch or tag in this repository.`, {
      details: { base },
    });
  }

  private async claimDirectory(path: string): Promise<void> {
    try {
      await this.fs.mkdir(path);
    } catch (error) {
      if (await this.exists(path)) throw alreadyExists(path);
      throw error;
    }
  }

  private async addWorktree(
    plan: CreationPlan,
    signal: AbortSignal | undefined,
    onOutput: (text: string) => void,
  ): Promise<void> {
    const added = await this.git(['worktree', 'add', '--detach', plan.path, plan.commit], plan.sourceRoot, {
      signal,
      onOutput,
      untimed: true,
    });
    if (added.exitCode !== 0) throw gitFailed(`git worktree add failed for ${plan.path}.`, added);
  }

  private async attachNewBranch(plan: CreationPlan, signal: AbortSignal | undefined): Promise<void> {
    const branch = plan.branch!;
    const ref = `refs/heads/${branch}`;
    const valid = await this.git(['check-ref-format', '--branch', branch], plan.sourceRoot, { signal });
    if (valid.exitCode !== 0) throw gitFailed(`Invalid branch name ${branch}.`, valid);
    const created = await this.git(['update-ref', ref, plan.commit, ''], plan.sourceRoot, { signal });
    if (created.exitCode !== 0) throw gitFailed(`Could not create branch ${branch}.`, created);
    try {
      const attached = await this.git(['symbolic-ref', 'HEAD', ref], plan.path, { signal });
      if (attached.exitCode !== 0) {
        throw gitFailed(`Could not switch worktree ${plan.path} to branch ${branch}.`, attached);
      }
    } catch (error) {
      await this.git(['update-ref', '-d', ref, plan.commit], plan.sourceRoot).catch(() => {});
      throw error;
    }
  }

  private async copyIncludes(plan: CreationPlan, signal: AbortSignal | undefined): Promise<readonly string[]> {
    const includeFile = join(plan.sourceRoot, INCLUDE_FILE);
    if (!(await this.isFile(includeFile))) return [];
    const options = { signal, untimed: true };
    const matched = await this.git(
      ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${includeFile}`],
      plan.sourceRoot,
      options,
    );
    if (matched.exitCode !== 0) throw includeFailed(matched.stderr);
    const candidates = splitNul(matched.stdout);
    if (candidates.length === 0) return [];
    const ignored = await this.git(['check-ignore', '-z', '--stdin'], plan.sourceRoot, {
      ...options,
      stdin: `${candidates.join('\0')}\0`,
    });
    if (ignored.exitCode !== 0 && ignored.exitCode !== 1) throw includeFailed(ignored.stderr);
    try {
      return await copyIncludedFiles({
        sourceRoot: plan.sourceRoot,
        worktreeRoot: plan.path,
        files: splitNul(ignored.stdout),
        signal,
      });
    } catch (error) {
      throw includeFailed(error instanceof Error ? error.message : String(error), error);
    }
  }

  private async discardWorktree(plan: CreationPlan, branchCreated: boolean): Promise<void> {
    await this.git(['worktree', 'remove', '--force', '--force', plan.path], plan.sourceRoot);
    await this.fs.remove(plan.path).catch(() => {});
    if (branchCreated && plan.branch !== undefined) {
      await this.git(['update-ref', '-d', `refs/heads/${plan.branch}`, plan.commit], plan.sourceRoot);
    }
  }

  private async readRepository(cwd: string, repoRoot: string, signal?: AbortSignal): Promise<Repository> {
    const listed = await this.git(['worktree', 'list', '--porcelain'], cwd, { signal });
    const entries = listed.exitCode === 0 ? parseWorktreeList(listed.stdout) : [];
    const main = entries[0];
    if (main === undefined) throw notGitRepo(cwd, listed);
    return { root: await canonicalPath(this.fs, repoRoot), bare: main.bare, entries };
  }

  private async kimiEntries(repo: Repository): Promise<readonly KimiEntry[]> {
    const parent = await canonicalPath(this.fs, this.worktreesDir(repo.root));
    const found: KimiEntry[] = [];
    for (const entry of repo.entries.slice(1)) {
      const lstat = await this.fs.lstat(entry.path).catch(() => undefined);
      if (lstat?.isSymbolicLink === true) continue;
      const path = await canonicalPath(this.fs, entry.path);
      if (!sameDir(dirname(path), parent)) continue;
      const missing = entry.prunable || lstat?.isDirectory !== true;
      found.push({
        entry,
        worktree: { path, name: basename(path), head: entry.head, branch: entry.branch, missing },
      });
    }
    return found;
  }

  private async findKimiEntry(repo: Repository, path: string): Promise<KimiEntry> {
    const normalized = resolve(path);
    const lstat = await this.fs.lstat(normalized).catch(() => undefined);
    const wanted = lstat?.isSymbolicLink === true ? undefined : await canonicalPath(this.fs, normalized);
    const match =
      wanted === undefined
        ? undefined
        : (await this.kimiEntries(repo)).find(({ worktree }) => sameDir(worktree.path, wanted));
    if (match === undefined) {
      throw new Error2(ErrorCodes.WORKTREE_NOT_FOUND, `${path} is not a Kimi worktree of ${repo.root}.`, {
        details: { path, repoRoot: repo.root },
      });
    }
    return match;
  }

  private async measureRemoval(
    repo: Repository,
    target: KimiEntry,
    deleteBranch: boolean,
    excludeSessionId?: string,
  ): Promise<WorktreeRemovalCheck> {
    const { worktree } = target;
    let uncommittedFiles = 0;
    if (!worktree.missing) {
      const status = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree.path);
      if (status.exitCode !== 0) throw gitFailed(`Could not read the status of ${worktree.path}.`, status);
      uncommittedFiles = countStatusEntries(status.stdout) + (await this.countHiddenEdits(worktree.path));
    }
    const sessions = await this.presence.sessionsUnder(worktree.path, { excludeSessionId });
    return {
      path: worktree.path,
      missing: worktree.missing,
      branch: worktree.branch,
      uncommittedFiles,
      uniqueCommits: await this.countUniqueCommits(repo, target, deleteBranch),
      openSessionIds: sessions.openSessionIds,
      closedSessionCount: sessions.closedSessionCount,
    };
  }

  private async countHiddenEdits(root: string): Promise<number> {
    const listed = await this.git(['ls-files', '-v', '-s', '-z'], root);
    if (listed.exitCode !== 0) throw gitFailed(`Could not read the index of ${root}.`, listed);
    const hidden = hiddenIndexEntries(listed.stdout);
    const checked = await Promise.all(
      hidden.map(async (entry) => ({
        entry,
        stat: await this.fs.lstat(join(root, entry.path)).catch(() => undefined),
      })),
    );
    const presentFiles: typeof hidden = [];
    const presentSymlinks: typeof hidden = [];
    let modified = 0;
    for (const { entry, stat } of checked) {
      if (entry.isSymlink) {
        if (stat?.isSymbolicLink === true) presentSymlinks.push(entry);
        else if (stat !== undefined || !entry.skipWorktree) modified += 1;
      } else if (stat?.isFile === true && stat.isSymbolicLink !== true) {
        presentFiles.push(entry);
      } else if (stat !== undefined || !entry.skipWorktree) {
        modified += 1;
      }
    }
    if (presentFiles.length > 0) {
      const hashed = await this.git(['hash-object', '--stdin-paths'], root, {
        stdin: presentFiles.map((entry) => `${entry.path}\n`).join(''),
      });
      if (hashed.exitCode !== 0) throw gitFailed(`Could not read the files of ${root}.`, hashed);
      const hashes = hashed.stdout.split('\n');
      modified += presentFiles.filter((entry, i) => hashes[i] !== entry.object).length;
    }
    for (const entry of presentSymlinks) {
      const target = await readlink(join(root, entry.path)).catch(() => undefined);
      if (target === undefined) {
        if (!entry.skipWorktree) modified += 1;
        continue;
      }
      const hashed = await this.git(['hash-object', '--stdin'], root, { stdin: target });
      if (hashed.exitCode !== 0) throw gitFailed(`Could not hash symlink ${entry.path} of ${root}.`, hashed);
      if (hashed.stdout.trim() !== entry.object) modified += 1;
    }
    return modified;
  }

  private async countUniqueCommits(repo: Repository, target: KimiEntry, deleteBranch: boolean): Promise<number> {
    const { branch, head } = target.worktree;
    if (head === undefined) return 0;
    const otherHeads = repo.entries
      .filter((entry) => entry !== target.entry)
      .flatMap((entry) => (entry.head === undefined ? [] : [entry.head]));
    let tip: string;
    let excluded: string[];
    if (branch !== undefined) {
      if (!deleteBranch) return 0;
      tip = `refs/heads/${branch}`;
      excluded = [`--exclude=${branch}`, '--branches'];
    } else {
      tip = head;
      excluded = ['--branches'];
    }
    const counted = await this.git(
      ['rev-list', '--count', tip, '--not', ...excluded, '--remotes', '--tags', ...otherHeads],
      repo.root,
    );
    if (counted.exitCode !== 0) throw gitFailed(`Could not count the commits only reachable from ${tip}.`, counted);
    return Number.parseInt(counted.stdout.trim(), 10);
  }

  private async git(args: readonly string[], cwd: string, options: GitOptions = {}): Promise<RunResult> {
    const program = localProgram('git', cwd);
    if (program === undefined) {
      throw new Error2(ErrorCodes.WORKTREE_GIT_FAILED, 'git was not found on PATH.', { details: { stderr: '' } });
    }
    return this.run(program, args, {
      cwd,
      stdin: options.stdin,
      timeoutMs: options.untimed === true ? undefined : GIT_TIMEOUT_MS,
      signal: options.signal,
      onOutput: options.onOutput,
    });
  }

  private async run(program: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
    throwIfCancelled(options.signal);
    await this.environments.ready;
    const lease = this.environments.acquire({ environmentId: LOCAL_ENVIRONMENT_ID }, ['process']);
    try {
      const spawned = await lease.environment.process!
        .spawn(program, args, { cwd: options.cwd, env: options.env })
        .then(
          (proc) => ({ ok: true as const, proc }),
          (error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }),
        );
      if (!spawned.ok) {
        options.onOutput?.(`${spawned.message}\n`);
        return { exitCode: -1, stdout: '', stderr: spawned.message };
      }
      try {
        return await waitForProcess(spawned.proc, options);
      } finally {
        void spawned.proc.dispose();
      }
    } finally {
      lease.dispose();
    }
  }

  private async exists(path: string): Promise<boolean> {
    return this.fs.lstat(path).then(
      () => true,
      () => false,
    );
  }

  private async isDirectory(path: string): Promise<boolean> {
    return this.fs.stat(path).then(
      (stat) => stat.isDirectory,
      () => false,
    );
  }

  private async isFile(path: string): Promise<boolean> {
    return this.fs.stat(path).then(
      (stat) => stat.isFile,
      () => false,
    );
  }
}

async function waitForProcess(proc: IHostProcess, options: RunOptions): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const emitOutput = (text: string): void => {
    try {
      options.onOutput?.(text);
    } catch {}
  };
  const output = Promise.all([
    drain(proc.stdout, (text) => {
      stdout += text;
      emitOutput(text);
    }),
    drain(proc.stderr, (text) => {
      stderr += text;
      emitOutput(text);
    }),
  ]).catch(() => {});
  proc.stdin.on('error', () => {});
  proc.stdin.end(options.stdin);

  const exit = proc.wait().catch(() => -1);
  const outcome = await firstOutcome(exit, options.timeoutMs, options.signal);
  if (outcome !== 'exit') await terminate(proc, exit);
  const exitCode = await exit;
  await settlesWithin(output, OUTPUT_GRACE_MS);
  if (outcome === 'abort') throw cancelledError();
  if (outcome === 'timeout') {
    const note = `timed out after ${(options.timeoutMs ?? 0) / 1000}s`;
    return { exitCode: -1, stdout, stderr: stderr === '' ? note : `${stderr.trimEnd()}\n${note}` };
  }
  return { exitCode, stdout, stderr };
}

async function firstOutcome(
  exit: Promise<number>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<'exit' | 'timeout' | 'abort'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        resolve('timeout');
      }, timeoutMs);
    }
  });
  const aborted = new Promise<'abort'>((resolve) => {
    onAbort = () => {
      resolve('abort');
    };
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([exit.then(() => 'exit' as const), timedOut, aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}

async function terminate(proc: IHostProcess, exit: Promise<number>): Promise<void> {
  await proc.kill('SIGTERM').catch(() => {});
  if (await settlesWithin(exit, KILL_GRACE_MS)) return;
  await proc.kill('SIGKILL').catch(() => {});
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([promise.then(() => true as const), elapsed]);
  } finally {
    clearTimeout(timer);
  }
}

async function drain(stream: AsyncIterable<Uint8Array | string>, sink: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (text !== '') sink(text);
  }
  const rest = decoder.decode();
  if (rest !== '') sink(rest);
}

function localProgram(command: string, cwd: string): string | undefined {
  try {
    return resolveProgramPath(command, { cwd });
  } catch {
    return undefined;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function validateDiscardLimits(discard: {
  readonly uncommittedFiles: number;
  readonly uniqueCommits: number;
}): { readonly uncommittedFiles: number; readonly uniqueCommits: number } {
  if (
    !Number.isSafeInteger(discard.uncommittedFiles) ||
    discard.uncommittedFiles < 0 ||
    !Number.isSafeInteger(discard.uniqueCommits) ||
    discard.uniqueCommits < 0
  ) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      'Worktree discard limits must be finite nonnegative integers.',
      { details: { uncommittedFiles: discard.uncommittedFiles, uniqueCommits: discard.uniqueCommits } },
    );
  }
  return discard;
}

function isOutsideRoot(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelledError();
}

function cancelledError(): Error2 {
  return new Error2(ErrorCodes.WORKTREE_CANCELLED, 'Worktree operation cancelled.');
}

function notGitRepo(cwd: string, result?: RunResult): Error2 {
  return new Error2(ErrorCodes.WORKTREE_NOT_GIT_REPO, `${cwd} is not inside a git repository.`, {
    details: { cwd, stderr: result?.stderr ?? '' },
  });
}

function alreadyExists(path: string): Error2 {
  return new Error2(ErrorCodes.WORKTREE_ALREADY_EXISTS, `A worktree already exists at ${path}.`, {
    details: { path },
  });
}

function gitFailed(message: string, result: RunResult): Error2 {
  const stderr = result.stderr.trim();
  return new Error2(ErrorCodes.WORKTREE_GIT_FAILED, stderr === '' ? message : `${message}\n${stderr}`, {
    details: { stderr: result.stderr, exitCode: result.exitCode },
  });
}

function includeFailed(detail: string, cause?: unknown): Error2 {
  return new Error2(ErrorCodes.WORKTREE_INCLUDE_FAILED, `Copying files listed in ${INCLUDE_FILE} failed: ${detail.trim()}`, {
    details: { stderr: detail },
    cause,
  });
}

registerScopedService(LifecycleScope.App, IWorktreeService, WorktreeService, ScopeActivation.OnDemand, 'worktree');
