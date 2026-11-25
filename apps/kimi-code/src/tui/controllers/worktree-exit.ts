import { execFile } from 'node:child_process';

import type { BackgroundTaskInfo, KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import type { Component, Focusable } from '@moonshot-ai/pi-tui';

import { isExperimentalFlagEnabled } from '#/tui/commands/experimental-flags';
import {
  createLeaveWorktreePrompt,
  type LeaveWorktreeChoice,
  type WorktreeDeleteChoice,
  type WorktreeExitActiveWork,
  type WorktreeRemoval,
} from '#/tui/components/dialogs/worktree-choices';
import type { TUIState } from '#/tui/tui-state';
import type { AppState } from '#/tui/types';
import { sessionWorktree } from '#/tui/utils/session-work-dir';
import { abbreviateHome } from '#/utils/paths';
import { resolveCommandPath } from '#/utils/process/resolve-command';
import { quoteShellArg } from '#/utils/shell-quote';

import type { WorktreeCreationController } from './worktree-creation';
import { inspectWorktreeRemoval, removeWorktree } from './worktree-removal';

const IGNORED_CHECK_TIMEOUT_MS = 5_000;

export function worktreeHasIgnoredFiles(worktreePath: string): Promise<boolean> {
  const git = resolveCommandPath('git', worktreePath);
  if (git === undefined) return Promise.resolve(true);
  return new Promise((resolve) => {
    try {
      execFile(
        git,
        ['-C', worktreePath, 'status', '--porcelain=v1', '-z', '--ignored=matching'],
        { encoding: 'utf8', timeout: IGNORED_CHECK_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          if (error !== null) {
            resolve(true);
            return;
          }
          resolve(stdout.length > 0);
        },
      );
    } catch {
      resolve(true);
    }
  });
}

export type WorktreeExitOutcome =
  | {
      readonly kind: 'kept';
      readonly name: string;
      readonly path: string;
      readonly branch: string | undefined;
      readonly uniqueCommits: number;
    }
  | { readonly kind: 'in-use'; readonly name: string }
  | { readonly kind: 'deleted'; readonly name: string; readonly branch: string | undefined }
  | {
      readonly kind: 'delete-failed';
      readonly name: string;
      readonly path: string;
      readonly branch: string | undefined;
      readonly reason: string;
    }
  | { readonly kind: 'unchecked'; readonly name: string; readonly reason: string };

interface PendingExitDelete {
  readonly removal: WorktreeRemoval;
  readonly choice: WorktreeDeleteChoice;
  readonly excludeSessionId: string | undefined;
}

type ExitPlan =
  | { readonly kind: 'stay' }
  | { readonly kind: 'outcome'; readonly outcome: WorktreeExitOutcome }
  | ({ readonly kind: 'delete' } & PendingExitDelete);

export interface WorktreeExitHost {
  readonly harness: Pick<KimiHarness, 'inspectWorktreeRemoval' | 'removeWorktree'>;
  readonly state: Pick<TUIState, 'appState'>;
  readonly worktreeCreation: Pick<WorktreeCreationController, 'createdThisRun'>;
  readonly backgroundTasks: ReadonlyMap<string, Pick<BackgroundTaskInfo, 'status'>>;
  readonly hasIgnoredFiles?: (worktreePath: string) => Promise<boolean>;
  hasSessionContent(): boolean;
  mountEditorReplacement(panel: Component & Focusable, onDisplaced?: () => void): void;
  restoreEditor(): void;
  stop(exitCode?: number): Promise<void>;
}

type Worktree = NonNullable<AppState['worktree']>;

export class WorktreeExitController {
  outcome: WorktreeExitOutcome | undefined;
  private readonly sessionStartedIn = new Map<string, string>();
  private pendingDelete: PendingExitDelete | undefined;
  private leaving = false;

  constructor(private readonly host: WorktreeExitHost) {}

  noteNewSession(sessionId: string): void {
    const worktree = sessionWorktree(this.host.state.appState);
    if (worktree !== undefined) this.sessionStartedIn.set(sessionId, worktree.root);
  }

  async exit(): Promise<void> {
    const worktree = isExperimentalFlagEnabled('worktree')
      ? sessionWorktree(this.host.state.appState)
      : undefined;
    if (worktree === undefined) return this.host.stop();
    if (this.leaving) return;
    this.leaving = true;
    try {
      const plan = await this.decide(worktree);
      if (plan.kind === 'stay') return;
      if (plan.kind === 'delete') {
        this.pendingDelete = plan;
      } else {
        this.outcome = plan.outcome;
      }
      await this.host.stop();
    } finally {
      this.pendingDelete = undefined;
      this.leaving = false;
    }
  }

  async finishShutdown(): Promise<void> {
    const pending = this.pendingDelete;
    if (pending === undefined) return;
    this.pendingDelete = undefined;
    const branch = pending.choice === 'delete-branch' ? pending.removal.branch : undefined;
    try {
      await removeWorktree(
        this.host.harness,
        pending.removal,
        pending.choice,
        pending.excludeSessionId,
      );
    } catch (error) {
      this.outcome = {
        kind: 'delete-failed',
        name: pending.removal.name,
        path: pending.removal.path,
        branch,
        reason: error instanceof Error ? error.message : String(error),
      };
      return;
    }
    this.outcome = {
      kind: 'deleted',
      name: pending.removal.name,
      branch,
    };
  }

  private async decide(worktree: Worktree): Promise<ExitPlan> {
    let removal: WorktreeRemoval;
    try {
      removal = await this.inspect(worktree);
    } catch (error) {
      return {
        kind: 'outcome',
        outcome: {
          kind: 'unchecked',
          name: worktree.name,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (removal.openSessionIds.length > 0) {
      return { kind: 'outcome', outcome: { kind: 'in-use', name: worktree.name } };
    }
    const excludeSessionId = this.currentSessionId();
    if (this.untouched(worktree, removal) && !(await this.hasIgnoredFiles(worktree.root))) {
      return { kind: 'delete', removal, choice: 'delete', excludeSessionId };
    }
    const choice = await this.choose(removal);
    if (choice === 'cancel') return { kind: 'stay' };
    if (choice === 'keep') {
      return {
        kind: 'outcome',
        outcome: {
          kind: 'kept',
          name: worktree.name,
          path: worktree.root,
          branch: removal.branch,
          uniqueCommits: removal.commitsLostWithWorktree,
        },
      };
    }
    return { kind: 'delete', removal, choice, excludeSessionId };
  }

  private inspect(worktree: Worktree): Promise<WorktreeRemoval> {
    return inspectWorktreeRemoval(this.host.harness, {
      repoRoot: worktree.repoRoot,
      worktree: { path: worktree.root, name: worktree.name },
      excludeSessionId: this.currentSessionId(),
    });
  }

  private hasIgnoredFiles(worktreePath: string): Promise<boolean> {
    return (this.host.hasIgnoredFiles ?? worktreeHasIgnoredFiles)(worktreePath);
  }

  private activeWork(): WorktreeExitActiveWork {
    const { streamingPhase, isCompacting } = this.host.state.appState;
    let backgroundTasks = 0;
    for (const info of this.host.backgroundTasks.values()) {
      if (info.status === 'running') backgroundTasks += 1;
    }
    return {
      foreground: streamingPhase !== 'idle' || isCompacting,
      backgroundTasks,
    };
  }

  private untouched(worktree: Worktree, removal: WorktreeRemoval): boolean {
    const created = this.host.worktreeCreation.createdThisRun.get(worktree.root);
    const { sessionId } = this.host.state.appState;
    const active = this.activeWork();
    return (
      created !== undefined &&
      !created.setupScriptRan &&
      (sessionId === '' || this.sessionStartedIn.get(sessionId) === worktree.root) &&
      !this.host.hasSessionContent() &&
      !active.foreground &&
      active.backgroundTasks === 0 &&
      removal.branch === undefined &&
      removal.uncommittedFiles === 0 &&
      removal.commitsLostWithWorktree === 0 &&
      removal.closedSessionCount === 0 &&
      removal.hasSubmodules !== true &&
      removal.locked !== true
    );
  }

  private currentSessionId(): string | undefined {
    const { sessionId } = this.host.state.appState;
    return sessionId === '' ? undefined : sessionId;
  }

  private choose(removal: WorktreeRemoval): Promise<LeaveWorktreeChoice> {
    const activeWork = this.activeWork();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (choice: LeaveWorktreeChoice, restore: boolean): void => {
        if (settled) return;
        settled = true;
        if (restore) this.host.restoreEditor();
        resolve(choice);
      };
      this.host.mountEditorReplacement(
        createLeaveWorktreePrompt({
          removal,
          activeWork,
          onChoose: (choice) => {
            finish(choice, true);
          },
        }),
        () => {
          finish('cancel', false);
        },
      );
    });
  }
}

export function formatWorktreeExit(outcome: WorktreeExitOutcome): string[] {
  switch (outcome.kind) {
    case 'kept': {
      const displayPath = abbreviateHome(outcome.path);
      const checkout = outcome.branch === undefined ? 'detached HEAD' : `branch ${outcome.branch}`;
      const lines = [`Kept worktree ${outcome.name} at ${displayPath} (${checkout}).`];
      if (outcome.branch === undefined && outcome.uniqueCommits > 0) {
        const one = outcome.uniqueCommits === 1;
        lines.push(
          `${outcome.uniqueCommits} ${one ? 'commit exists' : 'commits exist'} only in this worktree. To keep ${one ? 'it' : 'them'} on a branch:`,
          `  git -C ${quoteShellArg(outcome.path)} switch -c <branch-name>`,
        );
      }
      return lines;
    }
    case 'in-use':
      return [`Kept worktree ${outcome.name}: it is open in another Kimi Code window.`];
    case 'deleted':
      return [
        outcome.branch === undefined
          ? `Deleted worktree ${outcome.name}.`
          : `Deleted worktree ${outcome.name} and branch ${outcome.branch}.`,
      ];
    case 'delete-failed': {
      const displayPath = abbreviateHome(outcome.path);
      const target =
        outcome.branch === undefined
          ? `worktree ${outcome.name}`
          : `worktree ${outcome.name} and branch ${outcome.branch}`;
      return [`Couldn't delete ${target} (${displayPath}): ${outcome.reason}`];
    }
    case 'unchecked':
      return [`Couldn't check worktree ${outcome.name}, so it was left as it is: ${outcome.reason}`];
  }
}
