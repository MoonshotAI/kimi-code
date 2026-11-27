import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';

import {
  ErrorCodes,
  isKimiError,
  sameDir,
  type KimiHarness,
  type WorktreeListing,
} from '@moonshot-ai/kimi-code-sdk';
import type { Component, Focusable } from '@moonshot-ai/pi-tui';

import {
  createWorktreeDeletePrompt,
  type WorktreeDeleteChoice,
  type WorktreeRemoval,
} from '#/tui/components/dialogs/worktree-choices';
import {
  WorktreeFormComponent,
  type WorktreeFormField,
  type WorktreeFormValue,
} from '#/tui/components/dialogs/worktree-form';
import {
  WorktreePanelComponent,
  type WorktreePanelNotice,
  type WorktreePanelRow,
  type WorktreeRow,
} from '#/tui/components/dialogs/worktree-panel';
import {
  WORKTREE_PANEL_MAX_BODY_ROWS,
  WORKTREE_PANEL_PAGE_SIZE,
} from '#/tui/constant/worktree';
import type { ColorToken } from '#/tui/theme';
import type { TUIState } from '#/tui/tui-state';
import type { AppState, WorkLocation } from '#/tui/types';
import { abbreviateHome } from '#/utils/paths';
import { isDirectory } from '#/utils/session-directory';

import type { WorktreeCreationController } from './worktree-creation';
import { inspectWorktreeRemoval, removeWorktree } from './worktree-removal';

export interface WorktreePanelHost {
  readonly harness: Pick<KimiHarness, 'listWorktrees' | 'inspectWorktreeRemoval' | 'removeWorktree'>;
  readonly state: Pick<TUIState, 'appState' | 'dockContainer' | 'ui'>;
  readonly worktreeCreation: Pick<WorktreeCreationController, 'run' | 'cancel'>;
  readonly session: { readonly id: string } | undefined;
  mountEditorReplacement(panel: Component & Focusable, onDisplaced?: () => void): void;
  restoreEditor(): void;
  showStatus(message: string, color?: ColorToken): void;
  showError(message: string): void;
  startSessionAt(location: WorkLocation): Promise<boolean>;
  canMoveSessionToWorktree?(): boolean;
  precheckMoveSession?(): Promise<void> | void;
  moveSessionTo?(location: WorkLocation): Promise<boolean>;
}

interface Destination {
  readonly location: WorkLocation;
  readonly missingSubdir?: string;
}

interface PendingDelete {
  readonly rowPath: string;
  readonly canonicalPath: string;
  readonly name: string;
}

export class WorktreePanelController {
  private listing: WorktreeListing | undefined;
  private panel: WorktreePanelComponent | undefined;
  private mounted: (Component & Focusable) | undefined;
  private entering = false;
  private inspectToken = 0;
  private readonly pendingDeletes = new Map<string, PendingDelete>();
  private readonly deleteTasks = new Set<Promise<void>>();

  constructor(private readonly host: WorktreePanelHost) {}

  get pendingDeleteLabel(): string | undefined {
    const names = [...this.pendingDeletes.values()].map((pending) => pending.name);
    if (names.length === 0) return undefined;
    if (names.length === 1) return `Deleting worktree ${names[0]}…`;
    return `Deleting ${String(names.length)} worktrees…`;
  }

  async waitForPendingDeletes(): Promise<void> {
    if (this.deleteTasks.size === 0) return;
    await Promise.allSettled(this.deleteTasks);
  }

  async open(): Promise<void> {
    const listing = await this.fetchListing();
    if (listing === undefined) return;
    this.panel = new WorktreePanelComponent({
      repoName: basename(listing.repoRoot),
      rows: this.visibleRows(listing),
      pageSize: WORKTREE_PANEL_PAGE_SIZE,
      layout:
        this.host.state.dockContainer === undefined
          ? undefined
          : { maxBodyRows: WORKTREE_PANEL_MAX_BODY_ROWS },
      onOpen: (row) => {
        void this.enter(row);
      },
      onNew: (initialName) => {
        this.showForm(initialName);
      },
      onDelete: (row) => {
        void this.delete(row);
      },
      onCancel: () => {
        this.close();
      },
    });
    const pendingNotice = this.pendingDeleteNotice();
    if (pendingNotice !== undefined) this.panel.setNotice(pendingNotice);
    this.mount(this.panel);
  }

  private async enter(row: WorktreePanelRow): Promise<void> {
    const listing = this.listing;
    if (this.entering || listing === undefined) return;
    this.entering = true;
    this.inspectToken += 1;
    try {
      const destination = await destinationFor(listing, row, this.host.state.appState);
      this.close();
      if (!(await this.host.startSessionAt(destination.location))) return;
      this.host.showStatus(arrivalNotice(row, listing.repoRoot));
      if (destination.missingSubdir !== undefined) {
        this.host.showStatus(missingSubdirNotice(destination.missingSubdir, row.kind), 'warning');
      }
    } finally {
      this.entering = false;
    }
  }

  private showForm(initialName?: string): void {
    if (this.entering) return;
    this.inspectToken += 1;
    const canMoveSession =
      this.host.canMoveSessionToWorktree?.() === true && this.host.moveSessionTo !== undefined;
    const form: WorktreeFormComponent = new WorktreeFormComponent({
      initialName,
      canMoveSession,
      onSubmit: (value) => {
        void this.create(form, value);
      },
      onCancel: () => {
        this.host.worktreeCreation.cancel();
        if (this.panel !== undefined && this.mounted === form) this.mount(this.panel);
      },
    });
    this.mount(form);
  }

  private async create(form: WorktreeFormComponent, value: WorktreeFormValue): Promise<void> {
    const moveSession = value.sessionAction === 'move' && this.host.moveSessionTo !== undefined;
    await this.host.worktreeCreation.run(
      {
        name: value.name,
        base: value.base,
        mode: moveSession ? 'move' : 'new',
      },
      {
        beforeCreate: moveSession ? () => this.host.precheckMoveSession?.() : undefined,
        onRejected: (error) => {
          if (this.mounted !== form) {
            this.host.showError(engineMessage(error));
            return;
          }
          form.showError(engineMessage(error), fieldAtFault(error));
          this.host.state.ui.requestRender();
        },
        onAccepted: () => {
          if (this.mounted === form) this.close();
        },
        enter: (location) =>
          moveSession ? this.host.moveSessionTo!(location) : this.host.startSessionAt(location),
      },
    );
  }

  private async delete(row: WorktreeRow): Promise<void> {
    const { listing, panel } = this;
    if (this.entering || listing === undefined || panel === undefined) return;
    if (this.isPendingDelete(row.worktree.path)) return;
    const token = ++this.inspectToken;
    const name = row.worktree.name;
    const excludeSessionId = this.host.session?.id;
    this.notify({ text: `Checking ${name}…`, tone: 'textMuted' });
    let removal: WorktreeRemoval;
    try {
      removal = await inspectWorktreeRemoval(this.host.harness, {
        repoRoot: listing.repoRoot,
        worktree: row.worktree,
        excludeSessionId,
      });
    } catch (error) {
      if (token === this.inspectToken && this.mounted === panel) {
        this.notify({ text: engineMessage(error), tone: 'error' });
      }
      return;
    }
    if (token !== this.inspectToken || this.mounted !== panel) return;
    if (removal.openSessionIds.length > 0) {
      this.notify({ text: inUseNotice(name), tone: 'warning' });
      return;
    }
    const choice = await this.choose<WorktreeDeleteChoice | 'keep'>((onChoose) =>
      createWorktreeDeletePrompt({ removal, onChoose }),
    );
    if (choice === undefined || token !== this.inspectToken) return;
    this.mount(panel);
    if (choice === 'keep') {
      this.notify(this.pendingDeleteNotice());
      return;
    }
    const pendingKey = removal.path;
    this.pendingDeletes.set(pendingKey, {
      rowPath: row.worktree.path,
      canonicalPath: removal.path,
      name,
    });
    if (this.listing !== undefined) panel.setRows(this.visibleRows(this.listing));
    this.notify(this.pendingDeleteNotice());
    const task = this.runBackgroundDelete(pendingKey, removal, choice, excludeSessionId).finally(() => {
      this.deleteTasks.delete(task);
    });
    this.deleteTasks.add(task);
  }

  private async runBackgroundDelete(
    pendingKey: string,
    removal: WorktreeRemoval,
    choice: WorktreeDeleteChoice,
    excludeSessionId: string | undefined,
  ): Promise<void> {
    try {
      await removeWorktree(this.host.harness, removal, choice, excludeSessionId);
    } catch (error) {
      this.pendingDeletes.delete(pendingKey);
      if (this.panel !== undefined && this.listing !== undefined) {
        this.panel.setRows(this.visibleRows(this.listing));
      }
      const notice: WorktreePanelNotice =
        isKimiError(error) && error.code === ErrorCodes.WORKTREE_IN_USE
          ? { text: inUseNotice(removal.name), tone: 'warning' }
          : { text: engineMessage(error), tone: 'error' };
      this.reportBackgroundResult(notice);
      return;
    }
    this.pendingDeletes.delete(pendingKey);
    if (this.listing !== undefined) {
      this.listing = {
        ...this.listing,
        worktrees: this.listing.worktrees.filter((worktree) => !sameDir(worktree.path, removal.path)),
      };
      if (this.panel !== undefined) this.panel.setRows(this.visibleRows(this.listing));
    }
    const activePanel = this.panel;
    if (activePanel !== undefined && this.mounted === activePanel) {
      const refreshed = await this.fetchListing();
      if (refreshed !== undefined && this.panel === activePanel) {
        activePanel.setRows(this.visibleRows(refreshed));
      }
    }
    const done = deletedNotice(removal, choice);
    const remaining = this.pendingDeleteText();
    this.reportBackgroundResult({
      text: remaining === undefined ? done : `${done} ${remaining}`,
      tone: 'success',
    });
  }

  private visibleRows(listing: WorktreeListing): WorktreePanelRow[] {
    const markCurrent = !this.usesProjectRootFallback();
    if (this.pendingDeletes.size === 0) return panelRows(listing, markCurrent);
    return panelRows(
      {
        ...listing,
        worktrees: listing.worktrees.filter((worktree) => !this.isPendingDelete(worktree.path)),
      },
      markCurrent,
    );
  }

  private usesProjectRootFallback(): boolean {
    const { workDir, projectRoot } = this.host.state.appState;
    return !isDirectory(workDir) && projectRoot !== undefined;
  }

  private isPendingDelete(path: string): boolean {
    for (const pending of this.pendingDeletes.values()) {
      if (sameDir(pending.rowPath, path) || sameDir(pending.canonicalPath, path)) return true;
    }
    return false;
  }

  private pendingDeleteText(): string | undefined {
    const names = [...this.pendingDeletes.values()].map((pending) => pending.name);
    if (names.length === 0) return undefined;
    if (names.length === 1) return `Deleting ${names[0]}…`;
    return `Deleting ${String(names.length)} worktrees…`;
  }

  private pendingDeleteNotice(): WorktreePanelNotice | undefined {
    const text = this.pendingDeleteText();
    return text === undefined ? undefined : { text, tone: 'textMuted' };
  }

  private async fetchListing(): Promise<WorktreeListing | undefined> {
    const { workDir, projectRoot } = this.host.state.appState;
    const queryDir = isDirectory(workDir) || projectRoot === undefined ? workDir : projectRoot;
    try {
      this.listing = await this.host.harness.listWorktrees(queryDir);
      return this.listing;
    } catch (error) {
      this.host.showError(engineMessage(error));
      return undefined;
    }
  }

  private notify(notice: WorktreePanelNotice | undefined): void {
    if (this.panel !== undefined && this.mounted === this.panel) {
      this.panel.setNotice(notice);
      this.host.state.ui.requestRender();
    } else if (notice !== undefined && notice.tone !== 'textMuted') {
      this.host.showStatus(notice.text, notice.tone);
    }
  }

  private reportBackgroundResult(notice: WorktreePanelNotice): void {
    if (this.panel !== undefined && this.mounted === this.panel) {
      this.panel.setNotice(notice);
      this.host.state.ui.requestRender();
    } else if (notice.tone === 'error') {
      this.host.showError(notice.text);
    } else {
      this.host.showStatus(notice.text, notice.tone);
    }
  }

  private choose<T>(
    build: (onChoose: (choice: T) => void) => Component & Focusable,
  ): Promise<T | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (choice: T | undefined): void => {
        if (settled) return;
        settled = true;
        resolve(choice);
      };
      this.mount(build(settle), () => {
        settle(undefined);
      });
    });
  }

  private mount(component: Component & Focusable, onDisplaced?: () => void): void {
    this.mounted = component;
    this.host.mountEditorReplacement(component, () => {
      if (this.mounted === component) this.mounted = undefined;
      onDisplaced?.();
    });
  }

  private close(): void {
    this.inspectToken += 1;
    if (this.mounted !== undefined) this.host.restoreEditor();
  }
}

function isOutsideRoot(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel);
}

async function relativeInside(root: string, dir: string): Promise<string | undefined> {
  const [realRoot, realDir] = await Promise.all([
    realpath(root).catch(() => undefined),
    realpath(dir).catch(() => undefined),
  ]);
  if (realRoot !== undefined && realDir !== undefined) {
    const resolved = relative(realRoot, realDir);
    return isOutsideRoot(resolved) ? undefined : resolved;
  }
  const direct = relative(root, dir);
  return isOutsideRoot(direct) ? undefined : direct;
}

function panelRows(listing: WorktreeListing, markCurrent = true): WorktreePanelRow[] {
  const sourceRow: WorktreePanelRow | undefined = listing.bare
    ? undefined
    : {
        kind: 'source',
        path: listing.repoRoot,
        ...(listing.repoBranch !== undefined ? { branch: listing.repoBranch } : {}),
        ...(listing.repoHead !== undefined ? { head: listing.repoHead } : {}),
        current: markCurrent && sameDir(listing.currentCheckoutRoot, listing.repoRoot),
      };
  const worktreeRows: WorktreeRow[] = listing.worktrees.map((worktree) => ({
    kind: 'worktree',
    worktree,
    current: markCurrent && sameDir(listing.currentCheckoutRoot, worktree.path),
  }));
  const currentWorktree = worktreeRows.find((row) => row.current);
  const otherWorktrees = worktreeRows.filter((row) => !row.current);
  return [
    ...(currentWorktree === undefined ? [] : [currentWorktree]),
    ...(sourceRow === undefined ? [] : [sourceRow]),
    ...otherWorktrees,
  ];
}

async function destinationFor(
  listing: WorktreeListing,
  row: WorktreePanelRow,
  appState: Pick<AppState, 'workDir'>,
): Promise<Destination> {
  const subdir = isDirectory(appState.workDir)
    ? await relativeInside(listing.currentCheckoutRoot, appState.workDir)
    : undefined;
  const targetRoot = row.kind === 'source' ? listing.repoRoot : row.worktree.path;
  const worktree =
    row.kind === 'worktree' && row.worktree.managed
      ? { root: row.worktree.path, name: row.worktree.name, repoRoot: listing.repoRoot }
      : undefined;
  if (subdir === undefined || subdir === '') {
    return {
      location: { cwd: targetRoot, projectRoot: listing.repoRoot, isGitRepo: true, worktree },
    };
  }
  const cwd = join(targetRoot, subdir);
  const insideTarget = isDirectory(cwd) && (await relativeInside(targetRoot, cwd)) !== undefined;
  return insideTarget
    ? { location: { cwd, projectRoot: listing.repoRoot, isGitRepo: true, worktree } }
    : {
        location: { cwd: targetRoot, projectRoot: listing.repoRoot, isGitRepo: true, worktree },
        missingSubdir: subdir,
      };
}

function arrivalNotice(row: WorktreePanelRow, repoRoot: string): string {
  return row.kind === 'source'
    ? `Back in ${abbreviateHome(repoRoot)}`
    : `Now working in worktree ${row.worktree.name}`;
}

function deletedNotice(removal: WorktreeRemoval, choice: WorktreeDeleteChoice): string {
  return choice === 'delete-branch' && removal.branch !== undefined
    ? `Deleted ${removal.name} and branch ${removal.branch}.`
    : `Deleted ${removal.name}.`;
}

function missingSubdirNotice(subdir: string, target: WorktreePanelRow['kind']): string {
  return target === 'source'
    ? `${subdir} doesn't exist in the source checkout, so the session starts at the repository root.`
    : `${subdir} doesn't exist at this commit, so the session starts at the worktree root.`;
}

function inUseNotice(name: string): string {
  return `${name} is open in another Kimi Code window.`;
}

function fieldAtFault(error: unknown): WorktreeFormField | undefined {
  if (!isKimiError(error)) return undefined;
  if (
    error.code === ErrorCodes.WORKTREE_INVALID_NAME ||
    error.code === ErrorCodes.WORKTREE_ALREADY_EXISTS
  ) {
    return 'name';
  }
  if (error.code === ErrorCodes.WORKTREE_BASE_NOT_FOUND) return 'base';
  return undefined;
}

function engineMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = isKimiError(error) ? error.details?.['stderr'] : undefined;
  return typeof stderr === 'string' && stderr.trim() !== '' ? `${message}\n${stderr.trim()}` : message;
}
