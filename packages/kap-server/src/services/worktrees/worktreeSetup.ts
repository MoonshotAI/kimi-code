import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import type {
  WorktreeBase,
  WorktreeSetupFailure,
  WorktreeSetupRequest,
  WorktreeSetupStep,
  WorktreeSetupStepKind,
} from '../../protocol/worktree';
import { gitText, runGit, type CommandResult } from './command';
import {
  branchExists,
  isDirty,
  resolveRemoteRef,
  takenBranchNames,
  type RemoteBranchRef,
  type TakenBranchNames,
} from './gitRefs';

export const WORKTREE_BRANCH_PREFIX = 'kimi/';
export const FETCH_TIMEOUT_MS = 30_000;
const WORKTREE_ADD_TIMEOUT_MS = 10 * 60_000;
const CHANGES_TIMEOUT_MS = 10 * 60_000;
const SNAPSHOT_IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'worktree-setup',
  GIT_AUTHOR_EMAIL: 'worktree-setup@localhost',
  GIT_COMMITTER_NAME: 'worktree-setup',
  GIT_COMMITTER_EMAIL: 'worktree-setup@localhost',
};

export type SetupStep = { -readonly [K in keyof WorktreeSetupStep]: WorktreeSetupStep[K] };

export interface SetupProgress {
  readonly steps: SetupStep[];
  commandsRan: number;
  notify(outputOnly: boolean): void;
}

export interface CreatedWorktree {
  readonly path: string;
  readonly branch: string;
  readonly base: WorktreeBase;
  readonly includedLocalChanges: boolean;
}

export type StepOutcome<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'failed'; readonly step: WorktreeSetupStepKind; readonly failure: WorktreeSetupFailure }
  | { readonly kind: 'stopped'; readonly step: WorktreeSetupStepKind };

export function abbreviateHome(path: string, osHomeDir: string): string {
  if (osHomeDir.length === 0) return path;
  if (path === osHomeDir) return '~';
  return path.startsWith(osHomeDir + sep) ? `~${path.slice(osHomeDir.length)}` : path;
}

function quoteArg(arg: string): string {
  return /^[\w/:=.,@%+~-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function displayCommand(program: string, args: readonly string[]): string {
  return [program, ...args].map(quoteArg).join(' ');
}

export function randomBranchSuffix(): string {
  return randomBytes(2).toString('hex');
}

export interface WorktreeTarget {
  readonly branch: string;
  readonly path: string;
}

export function pickWorktreeTarget(
  taken: TakenBranchNames,
  projectDir: string,
  now: Date,
  suffix: string,
): WorktreeTarget {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const stem = `${month}${day}-${suffix}`;
  for (let attempt = 1; ; attempt++) {
    const shortName = attempt === 1 ? stem : `${stem}-${attempt}`;
    const branch = `${WORKTREE_BRANCH_PREFIX}${shortName}`;
    const path = join(projectDir, shortName);
    if (!taken.has(branch) && !existsSync(path)) return { branch, path };
  }
}

function setStep(
  progress: SetupProgress,
  kind: WorktreeSetupStepKind,
  patch: Partial<SetupStep>,
  outputOnly = false,
): void {
  const step = progress.steps.find((candidate) => candidate.kind === kind);
  if (step === undefined) return;
  Object.assign(step, patch);
  progress.notify(outputOnly);
}

async function runStepCommand(
  progress: SetupProgress,
  kind: WorktreeSetupStepKind,
  run: (onOutput: (tail: string) => void) => Promise<CommandResult>,
): Promise<CommandResult> {
  setStep(progress, kind, { state: 'running', output: undefined, timed_out: undefined });
  const result = await run((tail) => {
    setStep(progress, kind, { output: tail }, true);
  });
  progress.commandsRan += 1;
  return result;
}

function isDiskFull(result: CommandResult): boolean {
  return result.spawnError?.code === 'ENOSPC' || /No space left on device|ENOSPC/i.test(result.output);
}

export async function removeWorktreeArtifacts(
  repoRoot: string,
  target: WorktreeTarget,
  deleteBranch: boolean,
): Promise<void> {
  await runGit(repoRoot, ['worktree', 'remove', '--force', target.path]);
  await rm(target.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
    () => undefined,
  );
  await runGit(repoRoot, ['worktree', 'prune']);
  if (deleteBranch) await runGit(repoRoot, ['branch', '-D', target.branch]);
}

export type CopyIncludedFiles = (
  input: { readonly sourceRoot: string; readonly worktreePath: string },
  options: { readonly signal?: AbortSignal },
) => Promise<readonly string[]>;

export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

export interface WorktreeCreationOptions {
  readonly repoRoot: string;
  readonly copyIncludedFiles?: CopyIncludedFiles;
  readonly projectDir: string;
  readonly osHomeDir: string;
  readonly request: WorktreeSetupRequest;
  readonly fetchTimeoutMs?: number;
  readonly now?: () => Date;
  readonly randomSuffix?: () => string;
}

export class WorktreeCreation {
  private constructor(
    private readonly options: WorktreeCreationOptions,
    readonly target: WorktreeTarget,
    private readonly remote: RemoteBranchRef | undefined,
    private readonly includeChanges: boolean,
    private readonly copyIncludes: CopyIncludedFiles | undefined,
  ) {}

  static async plan(options: WorktreeCreationOptions): Promise<WorktreeCreation> {
    const { repoRoot, request } = options;
    const [remote, dirty, taken] = await Promise.all([
      request.use_remote === true ? resolveRemoteRef(repoRoot, request.source_branch) : undefined,
      request.include_local_changes === true ? isDirty(repoRoot) : false,
      takenBranchNames(repoRoot),
    ]);
    const target = pickWorktreeTarget(
      taken,
      options.projectDir,
      (options.now ?? (() => new Date()))(),
      (options.randomSuffix ?? randomBranchSuffix)(),
    );
    const copyIncludes =
      options.copyIncludedFiles !== undefined && existsSync(join(repoRoot, WORKTREE_INCLUDE_FILE))
        ? options.copyIncludedFiles
        : undefined;
    return new WorktreeCreation(options, target, remote, dirty, copyIncludes);
  }

  private fetchArgs(remote: RemoteBranchRef): string[] {
    return ['fetch', '--no-tags', remote.remote, `+${remote.remoteRef}:${remote.trackingRef}`];
  }

  private createArgs(start: string, path = this.target.path): string[] {
    return ['worktree', 'add', '--no-track', '-b', this.target.branch, path, start];
  }

  private createCommand(start: string): string {
    return displayCommand(
      'git',
      this.createArgs(start, abbreviateHome(this.target.path, this.options.osHomeDir)),
    );
  }

  plannedSteps(): SetupStep[] {
    const steps: SetupStep[] = [];
    if (this.remote !== undefined) {
      steps.push({
        kind: 'fetch',
        state: 'pending',
        ref: this.remote.ref,
        command: displayCommand('git', this.fetchArgs(this.remote)),
      });
    }
    const start = this.remote?.ref ?? this.options.request.source_branch;
    steps.push({ kind: 'create', state: 'pending', ref: start, command: this.createCommand(start) });
    if (this.includeChanges) steps.push({ kind: 'changes', state: 'pending' });
    if (this.copyIncludes !== undefined) steps.push({ kind: 'include', state: 'pending' });
    return steps;
  }

  async run(progress: SetupProgress, signal: AbortSignal): Promise<StepOutcome<CreatedWorktree>> {
    const fetched = await this.fetch(progress, signal);
    if (fetched.kind !== 'done') return fetched;
    const base = fetched.value;
    const created = await this.create(progress, signal, base);
    if (created.kind !== 'done') return created;
    const changes = await this.applyChanges(progress, signal, base);
    const included = changes.kind === 'done' ? await this.copyIncludedFiles(progress, signal) : changes;
    if (included.kind !== 'done') {
      await removeWorktreeArtifacts(this.options.repoRoot, this.target, true);
      return included;
    }
    return {
      kind: 'done',
      value: {
        path: this.target.path,
        branch: this.target.branch,
        base: { ...base, commit: created.value },
        includedLocalChanges: this.includeChanges,
      },
    };
  }

  private async fetch(
    progress: SetupProgress,
    signal: AbortSignal,
  ): Promise<StepOutcome<WorktreeBase>> {
    const local: WorktreeBase = { ref: this.options.request.source_branch, remote: false };
    const remote = this.remote;
    if (remote === undefined) return { kind: 'done', value: local };
    const timeoutMs = this.options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    const result = await runStepCommand(progress, 'fetch', (onOutput) =>
      runGit(this.options.repoRoot, this.fetchArgs(remote), { signal, timeoutMs, onOutput }),
    );
    if (result.aborted) {
      setStep(progress, 'fetch', { state: 'stopped' });
      return { kind: 'stopped', step: 'fetch' };
    }
    if (result.timedOut) {
      setStep(progress, 'fetch', { state: 'failed', timed_out: true, output: result.output });
      return {
        kind: 'failed',
        step: 'fetch',
        failure: {
          kind: 'fetch_timeout',
          remote_ref: remote.ref,
          timeout_seconds: Math.max(1, Math.round(timeoutMs / 1000)),
        },
      };
    }
    if (result.exitCode === 0) {
      setStep(progress, 'fetch', { state: 'done', output: undefined });
      return { kind: 'done', value: { ref: remote.ref, remote: true } };
    }
    if (/couldn't find remote ref/i.test(result.output)) {
      setStep(progress, 'fetch', { state: 'skipped', output: result.output });
      setStep(progress, 'create', { ref: local.ref, command: this.createCommand(local.ref) });
      return { kind: 'done', value: local };
    }
    setStep(progress, 'fetch', { state: 'failed', output: result.output });
    return { kind: 'failed', step: 'fetch', failure: { kind: 'fetch_failed', remote_ref: remote.ref } };
  }

  private async create(
    progress: SetupProgress,
    signal: AbortSignal,
    base: WorktreeBase,
  ): Promise<StepOutcome<string | undefined>> {
    const { repoRoot } = this.options;
    let reserved = false;
    let branchCreated = false;
    const result = await runStepCommand(progress, 'create', async (onOutput) => {
      await mkdir(dirname(this.target.path), { recursive: true });
      await mkdir(this.target.path);
      reserved = true;
      if (await branchExists(repoRoot, this.target.branch)) {
        throw new Error(`a branch named '${this.target.branch}' already exists`);
      }
      branchCreated = true;
      return runGit(repoRoot, this.createArgs(base.ref), {
        signal,
        timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
        onOutput,
      });
    }).catch(commandFailure);
    if (result.exitCode === 0) {
      setStep(progress, 'create', { state: 'done', output: undefined });
      return { kind: 'done', value: await gitText(this.target.path, ['rev-parse', 'HEAD']) };
    }
    if (reserved) await removeWorktreeArtifacts(repoRoot, this.target, branchCreated);
    if (result.aborted) {
      setStep(progress, 'create', { state: 'stopped' });
      return { kind: 'stopped', step: 'create' };
    }
    setStep(progress, 'create', { state: 'failed', output: result.output });
    return {
      kind: 'failed',
      step: 'create',
      failure: { kind: isDiskFull(result) ? 'disk_full' : 'create_failed' },
    };
  }

  private async copyIncludedFiles(progress: SetupProgress, signal: AbortSignal): Promise<StepOutcome<void>> {
    const copy = this.copyIncludes;
    if (copy === undefined) return { kind: 'done', value: undefined };
    setStep(progress, 'include', { state: 'running', output: undefined });
    try {
      await copy({ sourceRoot: this.options.repoRoot, worktreePath: this.target.path }, { signal });
    } catch (error) {
      if (signal.aborted) {
        setStep(progress, 'include', { state: 'stopped' });
        return { kind: 'stopped', step: 'include' };
      }
      const output = error instanceof Error ? error.message : String(error);
      setStep(progress, 'include', { state: 'failed', output });
      return { kind: 'failed', step: 'include', failure: { kind: 'create_failed' } };
    }
    setStep(progress, 'include', { state: 'done', output: undefined });
    return { kind: 'done', value: undefined };
  }

  private async applyChanges(
    progress: SetupProgress,
    signal: AbortSignal,
    base: WorktreeBase,
  ): Promise<StepOutcome<void>> {
    if (!this.includeChanges) return { kind: 'done', value: undefined };
    let conflictFiles: string[] = [];
    const result = await runStepCommand(progress, 'changes', async (onOutput) => {
      const snapshot = await snapshotLocalChanges(this.options.repoRoot, signal);
      if (snapshot.commit === undefined) return snapshot.result;
      const pickArgs = ['cherry-pick', '--no-commit', snapshot.commit];
      setStep(progress, 'changes', {
        command: displayCommand('git', ['cherry-pick', '--no-commit', snapshot.commit.slice(0, 10)]),
      });
      const picked = await runGit(this.target.path, pickArgs, {
        signal,
        timeoutMs: CHANGES_TIMEOUT_MS,
        onOutput,
      });
      if (picked.exitCode !== 0) {
        const unmerged = await gitText(this.target.path, ['diff', '--name-only', '--diff-filter=U']);
        conflictFiles = (unmerged ?? '').split('\n').filter((line) => line.length > 0);
        return picked;
      }
      return runGit(this.target.path, ['reset', '-q'], { signal, onOutput });
    });
    if (result.exitCode === 0) {
      setStep(progress, 'changes', { state: 'done', output: undefined });
      return { kind: 'done', value: undefined };
    }
    if (result.aborted) {
      setStep(progress, 'changes', { state: 'stopped' });
      return { kind: 'stopped', step: 'changes' };
    }
    setStep(progress, 'changes', { state: 'failed', output: result.output });
    if (conflictFiles.length > 0) {
      return {
        kind: 'failed',
        step: 'changes',
        failure: {
          kind: 'conflict',
          conflict_files: conflictFiles,
          remote_ref: base.remote ? base.ref : undefined,
        },
      };
    }
    return {
      kind: 'failed',
      step: 'changes',
      failure: { kind: isDiskFull(result) ? 'disk_full' : 'create_failed' },
    };
  }
}

async function copyIndexKeepingTimestamp(source: string, destination: string): Promise<void> {
  const original = await stat(source);
  await copyFile(source, destination);
  await utimes(destination, original.atime, Math.floor(original.mtimeMs / 1000));
}

async function snapshotLocalChanges(
  repoRoot: string,
  signal: AbortSignal,
): Promise<{ readonly commit?: string; readonly result: CommandResult }> {
  const indexDir = await mkdtemp(join(tmpdir(), 'kimi-worktree-index-'));
  const env = { ...SNAPSHOT_IDENTITY, GIT_INDEX_FILE: join(indexDir, 'index') };
  const options = { env, signal, timeoutMs: CHANGES_TIMEOUT_MS };
  try {
    const indexPath = await gitText(repoRoot, ['rev-parse', '--git-path', 'index']);
    const copied =
      indexPath !== undefined &&
      (await copyIndexKeepingTimestamp(resolve(repoRoot, indexPath), env.GIT_INDEX_FILE).then(
        () => true,
        () => false,
      ));
    if (!copied) {
      const seeded = await runGit(repoRoot, ['read-tree', 'HEAD'], options);
      if (seeded.exitCode !== 0) return { result: seeded };
    }
    const added = await runGit(repoRoot, ['add', '-A'], options);
    if (added.exitCode !== 0) return { result: added };
    const tree = await runGit(repoRoot, ['write-tree'], options);
    if (tree.exitCode !== 0) return { result: tree };
    const commit = await runGit(
      repoRoot,
      ['commit-tree', tree.stdout.trim(), '-p', 'HEAD', '-m', 'worktree local changes'],
      options,
    );
    return commit.exitCode === 0 ? { commit: commit.stdout.trim(), result: commit } : { result: commit };
  } finally {
    await rm(indexDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface WorktreeRecreationOptions {
  readonly repoRoot: string;
  readonly osHomeDir: string;
  readonly path: string;
  readonly branch: string;
}

export function plannedRecreationSteps(options: WorktreeRecreationOptions): SetupStep[] {
  return [
    { kind: 'prune', state: 'pending', command: displayCommand('git', ['worktree', 'prune']) },
    {
      kind: 'create',
      state: 'pending',
      ref: options.branch,
      command: displayCommand('git', [
        'worktree',
        'add',
        abbreviateHome(options.path, options.osHomeDir),
        options.branch,
      ]),
    },
  ];
}

function commandFailure(error: unknown): CommandResult {
  const failure: NodeJS.ErrnoException = error instanceof Error ? error : new Error(String(error));
  return {
    exitCode: null,
    stdout: '',
    output: `${failure.message}\n`,
    timedOut: false,
    aborted: false,
    spawnError: failure,
  };
}

export async function recreateWorktree(
  options: WorktreeRecreationOptions,
  progress: SetupProgress,
  signal: AbortSignal,
): Promise<StepOutcome<void>> {
  const { repoRoot, path, branch } = options;
  const target = { path, branch };
  const pruned = await runStepCommand(progress, 'prune', (onOutput) =>
    runGit(repoRoot, ['worktree', 'prune'], { signal, onOutput }),
  );
  if (pruned.aborted) {
    setStep(progress, 'prune', { state: 'stopped' });
    return { kind: 'stopped', step: 'prune' };
  }
  if (pruned.exitCode !== 0) {
    setStep(progress, 'prune', { state: 'failed', output: pruned.output });
    return { kind: 'failed', step: 'prune', failure: { kind: 'create_failed' } };
  }
  setStep(progress, 'prune', { state: 'done', output: undefined });
  let reserved = false;
  const added = await runStepCommand(progress, 'create', async (onOutput) => {
    await mkdir(dirname(path), { recursive: true });
    await mkdir(path);
    reserved = true;
    return runGit(repoRoot, ['worktree', 'add', path, branch], {
      signal,
      timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
      onOutput,
    });
  }).catch(commandFailure);
  if (added.exitCode === 0) {
    setStep(progress, 'create', { state: 'done', output: undefined });
    return { kind: 'done', value: undefined };
  }
  if (reserved) await removeWorktreeArtifacts(repoRoot, target, false);
  if (added.aborted) {
    setStep(progress, 'create', { state: 'stopped' });
    return { kind: 'stopped', step: 'create' };
  }
  setStep(progress, 'create', { state: 'failed', output: added.output });
  return {
    kind: 'failed',
    step: 'create',
    failure: { kind: isDiskFull(added) ? 'disk_full' : 'create_failed' },
  };
}
