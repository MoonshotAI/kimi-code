import { realpath, stat } from 'node:fs/promises';

import {
  IBootstrapService,
  IFlagService,
  ISessionIndex,
  IProjectService,
  IWorktreeService,
  WORKTREE_FLAG_ENV,
  WORKTREE_FLAG_ID,
  isError2,
  patchSessionMetadata,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { Project } from '@moonshot-ai/agent-core-v2/app/project/project';
import { SessionErrors } from '@moonshot-ai/agent-core-v2/session/errors';

import { ErrorCode } from '../../protocol/error-codes';
import type { SessionWorktreeAction, SessionWorktreeRetryRequest } from '../../protocol/rest-worktree';
import type {
  WorktreeSetup,
  WorktreeSetupFailure,
  WorktreeSetupRequest,
} from '../../protocol/worktree';
import type { ServerLogger } from '../pinoLoggerService';
import { branchExists, isRepoRoot } from './gitRefs';
import { repointSession } from './sessionRepoint';
import { publishSessionUpdated } from './sessionUpdates';
import {
  forgetWorktreeFacts,
  liveWorktreeBranch,
  refreshWorktreeFacts,
  settleInterruptedSetup,
  storedSessionWorktree,
  withStoredSessionWorktree,
  type StoredSessionWorktree,
} from './sessionWorktreeState';
import { WorktreeError, stateInvalid } from './worktreeError';
import { WorktreeInventory } from './worktreeInventory';
import {
  WorktreeCreation,
  plannedRecreationSteps,
  recreateWorktree,
  removeWorktreeArtifacts,
  type CreatedWorktree,
  type SetupProgress,
  type SetupStep,
  type StepOutcome,
} from './worktreeSetup';

const OUTPUT_PUBLISH_INTERVAL_MS = 250;

export interface SessionWorktreeServiceOptions {
  readonly fetchTimeoutMs?: number;
  readonly logger?: Pick<ServerLogger, 'warn'>;
}

export interface PlannedWorktreeSetup {
  readonly stored: StoredSessionWorktree;
  readonly workspaceId: string;
  readonly creation: WorktreeCreation;
}

type StoredChange = (stored: StoredSessionWorktree) => StoredSessionWorktree;

class SetupRecorder implements SetupProgress {
  readonly steps: SetupStep[];
  commandsRan = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly core: Scope,
    readonly sessionId: string,
    private stored: StoredSessionWorktree,
  ) {
    this.steps = stored.setup.steps.map((step) => ({ ...step }));
    this.commandsRan = stored.setup.commands_ran;
  }

  get current(): StoredSessionWorktree {
    return this.stored;
  }

  notify(outputOnly: boolean): void {
    if (!outputOnly) {
      this.flushInBackground();
      return;
    }
    this.timer ??= setTimeout(() => this.flushInBackground(), OUTPUT_PUBLISH_INTERVAL_MS);
  }

  private flushInBackground(): void {
    this.flush().catch(() => undefined);
  }

  claim(target: { path: string; branch: string }): Promise<void> {
    return this.update((stored) => ({ ...stored, pending: { path: target.path, branch: target.branch } }));
  }

  update(change: StoredChange): Promise<void> {
    this.stored = change(this.stored);
    return this.flush();
  }

  flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const snapshot: StoredSessionWorktree = {
      ...this.stored,
      setup: {
        ...this.stored.setup,
        steps: this.steps.map((step) => ({ ...step })),
        commands_ran: this.commandsRan,
      },
    };
    this.stored = snapshot;
    const run = this.writes.then(async () => {
      await writeStoredWorktree(this.core, this.sessionId, () => snapshot);
    });
    this.writes = run.catch(() => undefined);
    return run;
  }
}

export async function writeStoredWorktree(
  core: Scope,
  sessionId: string,
  change: (stored: StoredSessionWorktree | undefined) => StoredSessionWorktree | undefined,
): Promise<StoredSessionWorktree | undefined> {
  let written: StoredSessionWorktree | undefined;
  await patchSessionMetadata(core.accessor, sessionId, (meta) => {
    written = change(storedSessionWorktree(meta.custom));
    return written === undefined
      ? undefined
      : { custom: withStoredSessionWorktree(meta.custom, written) };
  });
  if (written !== undefined) publishSessionUpdated(core, sessionId);
  return written;
}

function ended(
  setup: WorktreeSetup,
  status: WorktreeSetup['status'],
  extra: Partial<WorktreeSetup> = {},
): WorktreeSetup {
  return { ...setup, ...extra, status, ended_at: new Date().toISOString() };
}

function withoutPending(stored: StoredSessionWorktree): StoredSessionWorktree {
  const { pending: _pending, ...rest } = stored;
  return rest;
}

export class SessionWorktreeService {
  readonly inventory: WorktreeInventory;
  private readonly runs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly acting = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly core: Scope,
    private readonly options: SessionWorktreeServiceOptions = {},
  ) {
    this.inventory = new WorktreeInventory(core);
  }

  private get osHomeDir(): string {
    return this.core.accessor.get(IBootstrapService).osHomeDir;
  }

  isActive(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  async planCreate(
    workspace: Pick<Project, 'id' | 'root' | 'name'>,
    request: WorktreeSetupRequest,
  ): Promise<PlannedWorktreeSetup> {
    if (!this.core.accessor.get(IFlagService).enabled(WORKTREE_FLAG_ID)) {
      throw new WorktreeError(
        ErrorCode.WORKTREE_UNSUPPORTED,
        `worktrees are experimental; set ${WORKTREE_FLAG_ENV}=1 or enable "${WORKTREE_FLAG_ID}" under [experimental] in config.toml`,
      );
    }
    if (!(await isRepoRoot(workspace.root))) {
      throw new WorktreeError(
        ErrorCode.WORKTREE_UNSUPPORTED,
        `workspace root ${workspace.root} is not the root of a git repository`,
      );
    }
    if (!(await branchExists(workspace.root, request.source_branch))) {
      throw new WorktreeError(
        ErrorCode.VALIDATION_FAILED,
        `worktree.source_branch: branch ${request.source_branch} does not exist`,
      );
    }
    const worktreeService = this.core.accessor.get(IWorktreeService);
    const creation = await WorktreeCreation.plan({
      repoRoot: workspace.root,
      copyIncludedFiles: (input, options) => worktreeService.copyIncludedFiles(input, options),
      projectDir: worktreeService.worktreesDir(await realpath(workspace.root).catch(() => workspace.root)),
      osHomeDir: this.osHomeDir,
      request,
      fetchTimeoutMs: this.options.fetchTimeoutMs,
    });
    return {
      workspaceId: workspace.id,
      creation,
      stored: {
        repo_root: workspace.root,
        setup: {
          status: 'running',
          purpose: 'create',
          request,
          steps: creation.plannedSteps(),
          commands_ran: 0,
          started_at: new Date().toISOString(),
        },
      },
    };
  }

  start(sessionId: string, planned: PlannedWorktreeSetup): void {
    this.launch(sessionId, planned.stored, (recorder, signal) =>
      this.runCreate(recorder, planned, signal),
    );
  }

  private launch(
    sessionId: string,
    stored: StoredSessionWorktree,
    work: (recorder: SetupRecorder, signal: AbortSignal) => Promise<void>,
  ): void {
    const controller = new AbortController();
    const recorder = new SetupRecorder(this.core, sessionId, stored);
    const done = work(recorder, controller.signal)
      .catch(async (error: unknown) => {
        this.options.logger?.warn(
          { sessionId, err: error instanceof Error ? error.message : String(error) },
          'worktree setup failed unexpectedly',
        );
        await this.failUnexpectedly(recorder, error).catch(() => undefined);
      })
      .finally(() => {
        if (this.runs.get(sessionId)?.controller === controller) this.runs.delete(sessionId);
      });
    this.runs.set(sessionId, { controller, done });
  }

  private async failUnexpectedly(recorder: SetupRecorder, error: unknown): Promise<void> {
    const running = recorder.steps.find((step) => step.state === 'running');
    const kind = running?.kind ?? recorder.steps.at(-1)?.kind ?? 'create';
    if (running !== undefined) {
      running.state = 'failed';
      running.output = error instanceof Error ? error.message : String(error);
    }
    const pending = recorder.current.pending;
    if (pending !== undefined && recorder.current.path === undefined) {
      await removeWorktreeArtifacts(recorder.current.repo_root, pending, true);
    }
    await recorder.update((stored) => ({
      ...withoutPending(stored),
      setup: ended(stored.setup, 'failed', {
        stopped_step: kind,
        failure: { kind: 'create_failed' },
      }),
    }));
  }

  private async finishUnsuccessfully(
    recorder: SetupRecorder,
    outcome: Exclude<StepOutcome<unknown>, { kind: 'done' }>,
  ): Promise<void> {
    const failure: WorktreeSetupFailure | undefined =
      outcome.kind === 'failed' ? outcome.failure : undefined;
    await recorder.update((stored) => ({
      ...withoutPending(stored),
      setup: ended(stored.setup, outcome.kind, { stopped_step: outcome.step, failure }),
    }));
  }

  private async runCreate(
    recorder: SetupRecorder,
    planned: PlannedWorktreeSetup,
    signal: AbortSignal,
  ): Promise<void> {
    const outcome = await planned.creation.run(recorder, signal);
    if (outcome.kind !== 'done') {
      await this.finishUnsuccessfully(recorder, outcome);
      return;
    }
    const created = outcome.value;
    await recorder.update((stored) => ({
      ...withoutPending(stored),
      path: created.path,
      branch: created.branch,
      base: created.base,
      included_local_changes: created.includedLocalChanges,
    }));
    try {
      await repointSession(this.core, recorder.sessionId, created.path);
    } catch (error) {
      await this.discardCreated(recorder, created, error);
      return;
    }
    await recorder.update((stored) => ({ ...stored, setup: ended(stored.setup, 'ready') }));
  }

  private async discardCreated(
    recorder: SetupRecorder,
    created: CreatedWorktree,
    error: unknown,
  ): Promise<void> {
    await patchSessionMetadata(this.core.accessor, recorder.sessionId, (meta) =>
      meta.environmentCwd === created.path ? { environmentCwd: undefined } : undefined,
    ).catch(() => undefined);
    await removeWorktreeArtifacts(recorder.current.repo_root, created, true);
    const step = recorder.steps.find((candidate) => candidate.kind === 'create');
    if (step !== undefined) {
      step.state = 'failed';
      step.output = error instanceof Error ? error.message : String(error);
    }
    await recorder.update((stored) => {
      const { path: _path, branch: _branch, base: _base, included_local_changes: _included, ...rest } = stored;
      return {
        ...rest,
        setup: ended(stored.setup, 'failed', {
          stopped_step: 'create',
          failure: { kind: 'create_failed' },
        }),
      };
    });
  }

  private async runRecreate(recorder: SetupRecorder, signal: AbortSignal): Promise<void> {
    const { repo_root: repoRoot, path, branch } = recorder.current;
    if (path === undefined || branch === undefined) throw new Error('worktree is not recorded');
    const outcome = await recreateWorktree(
      { repoRoot, osHomeDir: this.osHomeDir, path, branch },
      recorder,
      signal,
    );
    if (outcome.kind !== 'done') {
      await this.finishUnsuccessfully(recorder, outcome);
      return;
    }
    forgetWorktreeFacts(recorder.current);
    await recorder.update((stored) => ({ ...withoutPending(stored), setup: ended(stored.setup, 'ready') }));
  }

  async read(sessionId: string): Promise<StoredSessionWorktree | undefined> {
    const summary = await this.core.accessor.get(ISessionIndex).get(sessionId);
    return storedSessionWorktree(summary?.custom);
  }

  act(
    sessionId: string,
    action: SessionWorktreeAction,
    body: SessionWorktreeRetryRequest = {},
  ): Promise<void> {
    const result = (this.acting.get(sessionId) ?? Promise.resolve()).then(() =>
      this.actNow(sessionId, action, body),
    );
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.acting.set(sessionId, settled);
    void settled.then(() => {
      if (this.acting.get(sessionId) === settled) this.acting.delete(sessionId);
    });
    return result;
  }

  private async actNow(
    sessionId: string,
    action: SessionWorktreeAction,
    body: SessionWorktreeRetryRequest,
  ): Promise<void> {
    const summary = await this.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) {
      throw new WorktreeError(ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    const stored = storedSessionWorktree(summary.custom);
    if (stored === undefined) {
      throw stateInvalid(`session ${sessionId} has no worktree setup`);
    }
    const status = stored.setup.status;
    const missing = stored.path !== undefined && (await isMissing(stored.path));
    const halted = status === 'failed' || status === 'stopped';
    switch (action) {
      case 'cancel': {
        if (status !== 'running') throw stateInvalid(`worktree setup is ${status}, not running`);
        const run = this.runs.get(sessionId);
        if (run === undefined) {
          await this.settleInterrupted(sessionId);
          return;
        }
        run.controller.abort();
        await run.done;
        return;
      }
      case 'retry': {
        if (!halted) throw stateInvalid(`worktree setup is ${status}; only a failed or stopped setup can be retried`);
        if (stored.setup.purpose === 'recreate') {
          await this.beginRecreate(sessionId, stored, missing);
          return;
        }
        if (stored.path !== undefined) {
          throw stateInvalid('the worktree already exists');
        }
        const workspace = await this.core.accessor.get(IProjectService).get(summary.workspaceId);
        if (workspace === undefined) {
          throw new WorktreeError(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${summary.workspaceId} does not exist`,
          );
        }
        const planned = await this.planCreate(workspace, {
          ...stored.setup.request,
          use_remote: body.use_remote ?? stored.setup.request.use_remote,
          include_local_changes:
            body.include_local_changes ?? stored.setup.request.include_local_changes,
        });
        await writeStoredWorktree(this.core, sessionId, () => planned.stored);
        this.start(sessionId, planned);
        return;
      }
      case 'use_local': {
        if (stored.path === undefined) {
          if (!halted) throw stateInvalid(`worktree setup is ${status}; it cannot switch to local mode`);
          await writeStoredWorktree(this.core, sessionId, (current) =>
            current === undefined ? undefined : { ...current, setup: ended(current.setup, 'local') },
          );
          return;
        }
        if (!missing || status === 'running') {
          throw stateInvalid('the session can only leave its worktree when the directory is missing');
        }
        await repointSession(this.core, sessionId, undefined);
        await writeStoredWorktree(this.core, sessionId, (current) => {
          if (current === undefined) return undefined;
          const { path: _path, branch: _branch, base: _base, included_local_changes: _included, ...rest } = current;
          return { ...rest, setup: ended(current.setup, 'local') };
        });
        return;
      }
      case 'recreate': {
        await this.beginRecreate(sessionId, stored, missing);
        return;
      }
    }
  }

  private async beginRecreate(
    sessionId: string,
    stored: StoredSessionWorktree,
    missing: boolean,
  ): Promise<void> {
    if (stored.setup.status === 'running') throw stateInvalid('worktree setup is already running');
    if (stored.path === undefined || stored.branch === undefined || !missing) {
      throw stateInvalid('only a session whose worktree directory is missing can recreate it');
    }
    const next: StoredSessionWorktree = {
      ...stored,
      setup: {
        status: 'running',
        purpose: 'recreate',
        request: stored.setup.request,
        steps: plannedRecreationSteps({
          repoRoot: stored.repo_root,
          osHomeDir: this.osHomeDir,
          path: stored.path,
          branch: stored.branch,
        }),
        commands_ran: 0,
        started_at: new Date().toISOString(),
      },
    };
    await writeStoredWorktree(this.core, sessionId, () => next);
    this.launch(sessionId, next, (recorder, signal) => this.runRecreate(recorder, signal));
  }

  private async settleInterrupted(sessionId: string): Promise<void> {
    let leftovers: StoredSessionWorktree | undefined;
    try {
      await writeStoredWorktree(this.core, sessionId, (current) => {
        if (current === undefined || current.setup.status !== 'running') return undefined;
        leftovers = current;
        return settleInterruptedSetup(current);
      });
    } catch (error) {
      if (isError2(error) && error.code === SessionErrors.codes.SESSION_OCCUPIED) return;
      throw error;
    }
    if (leftovers === undefined) return;
    const { repo_root: repoRoot, path, pending } = leftovers;
    if (leftovers.setup.purpose === 'recreate') {
      if (pending !== undefined) await removeWorktreeArtifacts(repoRoot, pending, false);
      return;
    }
    if (path !== undefined) {
      await patchSessionMetadata(this.core.accessor, sessionId, (meta) =>
        meta.environmentCwd === path ? undefined : { environmentCwd: path },
      );
      return;
    }
    if (pending !== undefined) await removeWorktreeArtifacts(repoRoot, pending, true);
  }

  async recoverInterrupted(): Promise<void> {
    const page = await this.core.accessor.get(ISessionIndex).listRecent({ includeArchived: true });
    for (const summary of page.items) {
      if (this.runs.has(summary.id)) continue;
      if (storedSessionWorktree(summary.custom)?.setup.status !== 'running') continue;
      await this.settleInterrupted(summary.id).catch((error: unknown) => {
        this.options.logger?.warn(
          { sessionId: summary.id, err: error instanceof Error ? error.message : String(error) },
          'interrupted worktree setup could not be settled',
        );
      });
    }
  }

  async refreshFacts(
    sessions: readonly { readonly id: string; readonly custom?: Record<string, unknown> }[],
  ): Promise<void> {
    await Promise.all(
      sessions.map(async (session) => {
        const stored = storedSessionWorktree(session.custom);
        if (stored?.path === undefined) return;
        await refreshWorktreeFacts(stored);
        const branch = liveWorktreeBranch(stored);
        if (branch === undefined || branch === stored.branch || stored.setup.status === 'running') return;
        this.recordBranch(session.id, stored.path, branch);
      }),
    );
  }

  private recordBranch(sessionId: string, path: string, branch: string): void {
    void patchSessionMetadata(this.core.accessor, sessionId, (meta) => {
      const current = storedSessionWorktree(meta.custom);
      if (current === undefined || current.path !== path || current.branch === branch) return undefined;
      return { custom: withStoredSessionWorktree(meta.custom, { ...current, branch }) };
    }).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const runs = [...this.runs.values()];
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map((run) => run.done));
  }
}

async function isMissing(path: string): Promise<boolean> {
  return stat(path).then(
    (entry) => !entry.isDirectory(),
    () => true,
  );
}
