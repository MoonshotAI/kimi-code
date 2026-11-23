import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import type { Component, Focusable } from '@moonshot-ai/pi-tui';

import { isExperimentalFlagEnabled } from '#/tui/commands/experimental-flags';
import {
  createLeaveWorktreePrompt,
  type LeaveWorktreeChoice,
  type WorktreeDeleteChoice,
  type WorktreeRemoval,
} from '#/tui/components/dialogs/worktree-choices';
import type { TUIState } from '#/tui/tui-state';
import type { AppState } from '#/tui/types';
import { formatErrorMessage } from '#/tui/utils/event-payload';
import { sessionWorktree } from '#/tui/utils/session-work-dir';
import { abbreviateHome } from '#/utils/paths';

import type { WorktreeCreationController } from './worktree-creation';
import { inspectWorktreeRemoval, removeWorktree } from './worktree-removal';

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
  | { readonly kind: 'unchecked'; readonly name: string; readonly reason: string };

export interface WorktreeExitHost {
  readonly harness: Pick<KimiHarness, 'inspectWorktreeRemoval' | 'removeWorktree'>;
  readonly state: Pick<TUIState, 'appState'>;
  readonly worktreeCreation: Pick<WorktreeCreationController, 'createdThisRun'>;
  hasSessionContent(): boolean;
  mountEditorReplacement(panel: Component & Focusable, onDisplaced?: () => void): void;
  restoreEditor(): void;
  showError(message: string): void;
  stop(exitCode?: number): Promise<void>;
}

type Worktree = NonNullable<AppState['worktree']>;

export class WorktreeExitController {
  outcome: WorktreeExitOutcome | undefined;
  private readonly sessionStartedIn = new Map<string, string>();
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
    let outcome: WorktreeExitOutcome | 'stay';
    try {
      outcome = await this.decide(worktree);
    } finally {
      this.leaving = false;
    }
    if (outcome === 'stay') return;
    this.outcome = outcome;
    await this.host.stop();
  }

  private async decide(worktree: Worktree): Promise<WorktreeExitOutcome | 'stay'> {
    let removal: WorktreeRemoval;
    try {
      removal = await this.inspect(worktree);
    } catch (error) {
      return {
        kind: 'unchecked',
        name: worktree.name,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (removal.openSessionIds.length > 0) return { kind: 'in-use', name: worktree.name };
    if (this.untouched(worktree, removal)) {
      const deleted = await this.remove(removal, 'delete');
      if (deleted !== undefined) return deleted;
    }
    for (;;) {
      const choice = await this.choose(removal);
      if (choice === 'cancel') return 'stay';
      if (choice === 'keep') {
        return {
          kind: 'kept',
          name: worktree.name,
          path: worktree.root,
          branch: removal.branch,
          uniqueCommits: removal.commitsLostWithWorktree,
        };
      }
      const deleted = await this.remove(removal, choice);
      if (deleted !== undefined) return deleted;
      removal = (await this.inspect(worktree).catch(() => undefined)) ?? removal;
    }
  }

  private inspect(worktree: Worktree): Promise<WorktreeRemoval> {
    return inspectWorktreeRemoval(this.host.harness, {
      repoRoot: worktree.repoRoot,
      worktree: { path: worktree.root, name: worktree.name },
      excludeSessionId: this.currentSessionId(),
    });
  }

  private untouched(worktree: Worktree, removal: WorktreeRemoval): boolean {
    const created = this.host.worktreeCreation.createdThisRun.get(worktree.root);
    const { sessionId } = this.host.state.appState;
    return (
      created !== undefined &&
      !created.setupScriptRan &&
      (sessionId === '' || this.sessionStartedIn.get(sessionId) === worktree.root) &&
      !this.host.hasSessionContent() &&
      removal.branch === undefined &&
      removal.uncommittedFiles === 0 &&
      removal.commitsLostWithWorktree === 0 &&
      removal.closedSessionCount === 0
    );
  }

  private async remove(
    removal: WorktreeRemoval,
    choice: WorktreeDeleteChoice,
  ): Promise<WorktreeExitOutcome | undefined> {
    try {
      await removeWorktree(this.host.harness, removal, choice, this.currentSessionId());
    } catch (error) {
      this.host.showError(formatErrorMessage(error));
      return undefined;
    }
    return {
      kind: 'deleted',
      name: removal.name,
      branch: choice === 'delete-branch' ? removal.branch : undefined,
    };
  }

  private currentSessionId(): string | undefined {
    const { sessionId } = this.host.state.appState;
    return sessionId === '' ? undefined : sessionId;
  }

  private choose(removal: WorktreeRemoval): Promise<LeaveWorktreeChoice> {
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
      const path = abbreviateHome(outcome.path);
      const checkout = outcome.branch === undefined ? 'detached HEAD' : `branch ${outcome.branch}`;
      const lines = [`Kept worktree ${outcome.name} at ${path} (${checkout}).`];
      if (outcome.branch === undefined && outcome.uniqueCommits > 0) {
        const one = outcome.uniqueCommits === 1;
        lines.push(
          `${outcome.uniqueCommits} ${one ? 'commit exists' : 'commits exist'} only in this worktree. To keep ${one ? 'it' : 'them'} on a branch:`,
          `  git -C ${path} switch -c <branch-name>`,
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
    case 'unchecked':
      return [`Couldn't check worktree ${outcome.name}, so it was left as it is: ${outcome.reason}`];
  }
}
