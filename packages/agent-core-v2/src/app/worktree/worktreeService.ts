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
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcess } from '#/os/interface/hostProcess';

import {
  IWorktreeService,
  WORKTREE_FLAG_ID,
  type CopyIncludedFilesInput,
  type CreateWorktreeInput,
  type CreateWorktreeOptions,
  type CreatedWorktree,
  type InspectWorktreeRemovalInput,
  type KimiWorktree,
  type RemoveWorktreeInput,
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
  submodulePaths,
  type PorcelainWorktree,
} from './worktreePorcelain';

const GIT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 2_000;
const OUTPUT_GRACE_MS = 1_000;
const MAX_NAME_ATTEMPTS = 20;
const INCLUDE_FILE = '.worktreeinclude';

interface Repository {
  readonly root: string;
  readonly bare: boolean;
  readonly entries: readonly PorcelainWorktree[];
}

interface LinkedEntry {
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
    const [checkout, project] = await Promise.all([
      this.resolveCheckout(cwd),
      this.projects.peekImplicit(cwd),
    ]);
    const projectRoot = project.root;
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
    const worktrees = (await this.linkedEntries(repo))
      .map(({ worktree }) => worktree)
      .toSorted(compareWorktrees);
    const main = repo.entries[0]!;
    return {
      repoRoot: repo.root,
      currentCheckoutRoot: checkout.checkoutRoot,
      bare: repo.bare,
      ...(!repo.bare && main.branch !== undefined ? { repoBranch: main.branch } : {}),
      ...(!repo.bare && main.head !== undefined ? { repoHead: main.head } : {}),
      worktrees,
    };
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
      if (plan.branch !== undefined) {
        try {
          await this.createBranchRef(plan, signal);
          branchCreated = true;
        } catch (error) {
          if (isError2(error) && error.code === ErrorCodes.WORKTREE_CANCELLED) branchCreated = true;
          throw error;
        }
      }
      await this.addWorktree(plan, signal, (text) => {
        emit({ type: 'output', step: 'add', text });
      });
      emit({ type: 'step', step: 'add', status: 'finished' });

      emit({ type: 'step', step: 'include', status: 'started' });
      copiedFiles = await this.copyIncludedFiles({ sourceRoot: plan.sourceRoot, worktreePath: plan.path }, { signal });
      throwIfCancelled(signal);
      emit({ type: 'step', step: 'include', status: 'finished' });
    } catch (error) {
      await this.discardWorktree(plan, branchCreated).catch(() => {});
      throw error;
    }

    const relativeCwd = relative(plan.sourceRoot, plan.cwd);
    const mappedCwd = isOutsideRoot(relativeCwd) ? plan.path : join(plan.path, relativeCwd);
    const cwdFallback = !(await this.isDirectory(mappedCwd));
    return {
      worktree: { path: plan.path, name: plan.name, head: plan.commit, branch: plan.branch, missing: false, managed: true },
      repoRoot: plan.repoRoot,
      sourceRoot: plan.sourceRoot,
      cwd: cwdFallback ? plan.path : mappedCwd,
      cwdFallback,
      copiedFiles,
      sourceDirty: plan.sourceDirty,
    };
  }

  async inspectRemoval(input: InspectWorktreeRemovalInput): Promise<WorktreeRemovalCheck> {
    const repo = await this.readRepository(input.repoRoot, input.repoRoot);
    const target = await this.findLinkedEntry(repo, input.path);
    return this.measureRemoval(repo, target, input);
  }

  async remove(input: RemoveWorktreeInput): Promise<void> {
    this.requireEnabled();
    const repo = await this.readRepository(input.repoRoot, input.repoRoot);
    const target = await this.findLinkedEntry(repo, input.path);
    const check = await this.measureRemoval(repo, target, input);
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
    const allowForce = input.force === true;
    const forceArgs =
      allowForce && check.locked === true
        ? ['--force', '--force']
        : allowForce
          ? ['--force']
          : check.hasSubmodules === true
            ? []
            : check.missing || check.uncommittedFiles > 0
              ? ['--force']
              : [];
    const removed = await this.git(['worktree', 'remove', ...forceArgs, check.path], repo.root, { untimed: true });
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
    const rawParent = resolve(worktreesDir);
    const parent = await canonicalPath(this.fs, rawParent);
    const registered = new Set(
      (await this.managedEntries(repo, rawParent, parent)).map(({ worktree }) => worktree.name),
    );
    const taken = async (candidate: string): Promise<boolean> =>
      registered.has(candidate) || (await this.exists(join(parent, candidate)));
    let name = explicitName ?? generateWorktreeName();
    if (explicitName === undefined) {
      for (let attempt = 1; attempt < MAX_NAME_ATTEMPTS && (await taken(name)); attempt++) name = generateWorktreeName();
    }
    const path = join(parent, name);
    if (await taken(name)) throw alreadyExists(path);

    const branch = nonEmpty(input.branch);
    if (branch !== undefined) {
      const valid = await this.git(['check-ref-format', '--branch', branch], sourceRoot, { signal });
      if (valid.exitCode !== 0) throw gitFailed(`Invalid branch name ${branch}.`, valid);
      const exists = await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], sourceRoot, {
        signal,
      });
      if (exists.exitCode === 0) throw gitFailed(`Branch ${branch} already exists.`, exists);
    }
    const status = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], sourceRoot, {
      signal,
    });
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

  private async createBranchRef(plan: CreationPlan, signal: AbortSignal | undefined): Promise<void> {
    const branch = plan.branch!;
    const created = await this.git(['update-ref', `refs/heads/${branch}`, plan.commit, ''], plan.sourceRoot, {
      signal,
    });
    if (created.exitCode !== 0) throw gitFailed(`Could not create branch ${branch}.`, created);
  }

  private async addWorktree(
    plan: CreationPlan,
    signal: AbortSignal | undefined,
    onOutput: (text: string) => void,
  ): Promise<void> {
    const args =
      plan.branch === undefined
        ? ['worktree', 'add', '--detach', '--', plan.path, plan.commit]
        : ['worktree', 'add', '--', plan.path, plan.branch];
    const added = await this.git(args, plan.sourceRoot, {
      signal,
      onOutput,
      untimed: true,
    });
    if (added.exitCode !== 0) throw gitFailed(`git worktree add failed for ${plan.path}.`, added);
  }

  async copyIncludedFiles(
    input: CopyIncludedFilesInput,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly string[]> {
    this.requireEnabled();
    const { signal } = options;
    const includeFile = join(input.sourceRoot, INCLUDE_FILE);
    if (!(await this.isFile(includeFile))) return [];
    const gitOptions = { signal, untimed: true };
    const matched = await this.git(
      ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${includeFile}`],
      input.sourceRoot,
      gitOptions,
    );
    if (matched.exitCode !== 0) throw includeFailed(matched.stderr);
    const candidates = splitNul(matched.stdout);
    if (candidates.length === 0) return [];
    const ignored = await this.git(['check-ignore', '-z', '--stdin'], input.sourceRoot, {
      ...gitOptions,
      stdin: `${candidates.join('\0')}\0`,
    });
    if (ignored.exitCode !== 0 && ignored.exitCode !== 1) throw includeFailed(ignored.stderr);
    try {
      return await copyIncludedFiles({
        sourceRoot: input.sourceRoot,
        worktreeRoot: input.worktreePath,
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
    if (listed.exitCode !== 0) throw gitFailed(`Could not list worktrees for ${cwd}.`, listed);
    const entries = parseWorktreeList(listed.stdout);
    const main = entries[0];
    if (main === undefined) throw notGitRepo(cwd, listed);
    return { root: await canonicalPath(this.fs, repoRoot), bare: main.bare, entries };
  }

  private async managedParentDirs(repo: Repository): Promise<{ readonly raw: string; readonly canonical: string }> {
    const raw = resolve(this.worktreesDir(repo.root));
    const canonical = await canonicalPath(this.fs, raw);
    return { raw, canonical };
  }

  private async resolveManagedOrLocked(
    entry: PorcelainWorktree,
    parentCanonical: string,
  ): Promise<LinkedEntry | undefined> {
    const lstat = await this.fs.lstat(entry.path).catch(() => undefined);
    if (lstat?.isSymbolicLink === true) return undefined;
    const path =
      lstat === undefined || sameDir(dirname(entry.path), parentCanonical)
        ? entry.path
        : await canonicalPath(this.fs, entry.path);
    const missing = entry.prunable || lstat?.isDirectory !== true;
    const managed = sameDir(dirname(path), parentCanonical);
    return {
      entry,
      worktree: { path, name: basename(path), head: entry.head, branch: entry.branch, missing, managed },
    };
  }

  private async managedEntries(
    repo: Repository,
    rawParent: string,
    canonicalParent: string,
  ): Promise<readonly LinkedEntry[]> {
    const candidates = repo.entries
      .slice(1)
      .filter((entry) => sameDir(dirname(entry.path), canonicalParent) || sameDir(dirname(entry.path), rawParent));
    const resolved = await Promise.all(
      candidates.map((entry) => this.resolveManagedOrLocked(entry, canonicalParent)),
    );
    return resolved.filter((item): item is LinkedEntry => item !== undefined && item.worktree.managed);
  }

  private async linkedEntries(repo: Repository): Promise<readonly LinkedEntry[]> {
    const parent = await this.managedParentDirs(repo);
    const entries = repo.entries.slice(1);
    const results = Array.from<LinkedEntry | undefined>({ length: entries.length });
    const toProbe: { readonly index: number; readonly entry: PorcelainWorktree }[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const maybeManaged =
        sameDir(dirname(entry.path), parent.canonical) || sameDir(dirname(entry.path), parent.raw);
      if (entry.prunable) {
        results[i] = {
          entry,
          worktree: {
            path: entry.path,
            name: basename(entry.path),
            head: entry.head,
            branch: entry.branch,
            missing: true,
            managed: maybeManaged,
          },
        };
        continue;
      }
      if (maybeManaged || entry.locked) {
        toProbe.push({ index: i, entry });
        continue;
      }
      results[i] = {
        entry,
        worktree: {
          path: entry.path,
          name: basename(entry.path),
          head: entry.head,
          branch: entry.branch,
          missing: false,
          managed: false,
        },
      };
    }

    if (toProbe.length > 0) {
      await Promise.all(
        toProbe.map(async ({ index, entry }) => {
          results[index] = await this.resolveManagedOrLocked(entry, parent.canonical);
        }),
      );
    }

    return results.filter((item): item is LinkedEntry => item !== undefined);
  }

  private async findLinkedEntry(repo: Repository, path: string): Promise<LinkedEntry> {
    const normalized = resolve(path);
    const targetStat = await this.fs.lstat(normalized).catch(() => undefined);
    if (targetStat?.isSymbolicLink === true) {
      throw new Error2(ErrorCodes.WORKTREE_NOT_FOUND, `${path} is not a linked worktree of ${repo.root}.`, {
        details: { path, repoRoot: repo.root },
      });
    }
    const wanted = await canonicalPath(this.fs, normalized);
    const parent = await this.managedParentDirs(repo);
    const linked = repo.entries.slice(1);
    let matched = linked.find((entry) => sameDir(entry.path, wanted) || sameDir(entry.path, normalized));
    if (matched === undefined) {
      const canonicalized = await Promise.all(
        linked.map(async (entry) => ({
          entry,
          canonical: await canonicalPath(this.fs, entry.path),
        })),
      );
      matched = canonicalized.find(({ canonical }) => sameDir(canonical, wanted))?.entry;
    }
    if (matched === undefined) {
      throw new Error2(ErrorCodes.WORKTREE_NOT_FOUND, `${path} is not a linked worktree of ${repo.root}.`, {
        details: { path, repoRoot: repo.root },
      });
    }
    const resolved = await this.resolveManagedOrLocked(matched, parent.canonical);
    if (resolved === undefined) {
      throw new Error2(ErrorCodes.WORKTREE_NOT_FOUND, `${path} is not a linked worktree of ${repo.root}.`, {
        details: { path, repoRoot: repo.root },
      });
    }
    return resolved;
  }

  private async measureRemoval(
    repo: Repository,
    target: LinkedEntry,
    input: InspectWorktreeRemovalInput,
  ): Promise<WorktreeRemovalCheck> {
    const { worktree } = target;
    let uncommittedFiles = 0;
    let hasSubmodules = false;
    if (!worktree.missing) {
      const [status, indexInfo] = await Promise.all([
        this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree.path),
        this.inspectIndex(worktree.path),
      ]);
      if (status.exitCode !== 0) throw gitFailed(`Could not read the status of ${worktree.path}.`, status);
      uncommittedFiles = countStatusEntries(status.stdout) + indexInfo.hiddenEdits;
      hasSubmodules = indexInfo.hasSubmodules;
    }
    const [sessions, uniqueCommits] = await Promise.all([
      this.presence.sessionsUnder(worktree.path, {
        excludeSessionId: input.excludeSessionId,
        excludeSessionIds: input.excludeSessionIds,
      }),
      this.countUniqueCommits(repo, target, input.deleteBranch, this.entriesAt(repo, input.removedTogether ?? [])),
    ]);
    return {
      path: worktree.path,
      missing: worktree.missing,
      branch: worktree.branch,
      uncommittedFiles,
      uniqueCommits,
      openSessionIds: sessions.openSessionIds,
      closedSessionCount: sessions.closedSessionCount,
      ...(hasSubmodules ? { hasSubmodules: true } : {}),
      ...(target.entry.locked ? { locked: true } : {}),
    };
  }

  private async inspectIndex(root: string): Promise<{ readonly hiddenEdits: number; readonly hasSubmodules: boolean }> {
    const listed = await this.git(['ls-files', '-v', '-s', '-z'], root);
    if (listed.exitCode !== 0) throw gitFailed(`Could not read the index of ${root}.`, listed);
    const hidden = hiddenIndexEntries(listed.stdout);
    const submodules = submodulePaths(listed.stdout);
    const [hiddenEdits, initializedSubmodules] = await Promise.all([
      this.countHiddenEntries(root, hidden),
      submodules.length === 0
        ? Promise.resolve(false)
        : Promise.all(submodules.map((subPath) => this.exists(join(root, subPath, '.git')))).then((hits) =>
            hits.some(Boolean),
          ),
    ]);
    return { hiddenEdits, hasSubmodules: initializedSubmodules };
  }

  private async countHiddenEntries(root: string, hidden: ReturnType<typeof hiddenIndexEntries>): Promise<number> {
    if (hidden.length === 0) return 0;
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

  private entriesAt(repo: Repository, paths: readonly string[]): ReadonlySet<PorcelainWorktree> {
    const wanted = paths.map((path) => resolve(path));
    return new Set(repo.entries.filter((entry) => wanted.some((path) => sameDir(entry.path, path))));
  }

  private async countUniqueCommits(
    repo: Repository,
    target: LinkedEntry,
    deleteBranch: boolean,
    removedTogether: ReadonlySet<PorcelainWorktree>,
  ): Promise<number> {
    const { branch, head } = target.worktree;
    if (head === undefined) return 0;
    const otherHeads = [
      ...new Set(
        repo.entries
          .filter((entry) => entry !== target.entry && !removedTogether.has(entry))
          .flatMap((entry) => (entry.head === undefined ? [] : [entry.head])),
      ),
    ];
    const deletedBranches = deleteBranch
      ? [...removedTogether].flatMap((entry) => (entry.branch === undefined ? [] : [`--exclude=${entry.branch}`]))
      : [];
    let tip: string;
    let excluded: string[];
    if (branch !== undefined) {
      if (!deleteBranch) return 0;
      tip = `refs/heads/${branch}`;
      excluded = [`--exclude=${branch}`, ...deletedBranches, '--branches'];
    } else {
      tip = head;
      excluded = [...deletedBranches, '--branches'];
    }
    const args = ['rev-list', '--count', tip, '--not', ...excluded, '--remotes', '--tags'];
    const counted = await this.git(
      otherHeads.length > 0 ? [...args, '--stdin'] : args,
      repo.root,
      otherHeads.length > 0 ? { stdin: otherHeads.map((sha) => `^${sha}\n`).join('') } : undefined,
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
      throwIfCancelled(options.signal);
      const spawned = await lease.environment.process!
        .spawn(program, args, { cwd: options.cwd })
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
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  const emitOutput = (text: string): void => {
    try {
      options.onOutput?.(text);
    } catch {}
  };
  let streamError: unknown;
  const output = Promise.all([
    drain(proc.stdout, (text) => {
      stdout += text;
      emitOutput(text);
    }),
    drain(proc.stderr, (text) => {
      stderr += text;
      emitOutput(text);
    }),
  ]).catch((error: unknown) => {
    streamError = error;
  });
  proc.stdin.on('error', () => {});
  proc.stdin.end(options.stdin);

  const exit = proc.wait().catch(() => -1);
  const outcome = await firstOutcome(exit, options.timeoutMs, options.signal);
  if (outcome !== 'exit') await terminate(proc, exit);
  const exitCode = await exit;
  if (outcome === 'exit') {
    const drainMs =
      options.timeoutMs === undefined
        ? undefined
        : Math.max(OUTPUT_GRACE_MS, options.timeoutMs - (Date.now() - startedAt));
    const drainOutcome = await firstOutcome(
      output.then(() => 0),
      drainMs,
      options.signal,
    );
    if (drainOutcome === 'abort') throw cancelledError();
    if (drainOutcome === 'timeout') {
      const note = `output stream did not close within ${(options.timeoutMs ?? 0) / 1000}s`;
      return { exitCode: -1, stdout, stderr: stderr === '' ? note : `${stderr.trimEnd()}\n${note}` };
    }
    if (streamError !== undefined) {
      const detail = streamError instanceof Error ? streamError.message : 'output stream failed';
      const note = `failed to read process output: ${detail}`;
      return { exitCode: -1, stdout, stderr: stderr === '' ? note : `${stderr.trimEnd()}\n${note}` };
    }
    return { exitCode, stdout, stderr };
  }
  await settlesWithin(output, OUTPUT_GRACE_MS);
  if (outcome === 'abort') throw cancelledError();
  const note = `timed out after ${(options.timeoutMs ?? 0) / 1000}s`;
  return { exitCode: -1, stdout, stderr: stderr === '' ? note : `${stderr.trimEnd()}\n${note}` };
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

function compareWorktrees(a: KimiWorktree, b: KimiWorktree): number {
  if (a.managed !== b.managed) return a.managed ? -1 : 1;
  return a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
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
