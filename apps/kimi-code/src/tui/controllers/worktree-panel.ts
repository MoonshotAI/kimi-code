import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';

import {
  ErrorCodes,
  isKimiError,
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
  type WorktreePanelTarget,
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
}

interface Destination {
  readonly location: WorkLocation;
  readonly missingSubdir?: string;
}

export class WorktreePanelController {
  private listing: WorktreeListing | undefined;
  private panel: WorktreePanelComponent | undefined;
  private mounted: (Component & Focusable) | undefined;
  private busy = false;

  constructor(private readonly host: WorktreePanelHost) {}

  async open(): Promise<void> {
    const listing = await this.fetchListing();
    if (listing === undefined) return;
    this.panel = new WorktreePanelComponent({
      repoName: basename(listing.repoRoot),
      rows: panelRows(listing, this.host.state.appState),
      pageSize: WORKTREE_PANEL_PAGE_SIZE,
      layout:
        this.host.state.dockContainer === undefined
          ? undefined
          : { maxBodyRows: WORKTREE_PANEL_MAX_BODY_ROWS },
      onOpen: (row) => {
        void this.enter(row);
      },
      onNew: () => {
        this.showForm();
      },
      onDelete: (row) => {
        void this.delete(row);
      },
      onCancel: () => {
        this.close();
      },
    });
    this.mount(this.panel);
  }

  private async enter(row: WorktreePanelTarget): Promise<void> {
    const listing = this.listing;
    if (this.busy || listing === undefined) return;
    const destination = await destinationFor(listing, row, this.host.state.appState);
    this.close();
    if (!(await this.host.startSessionAt(destination.location))) return;
    this.host.showStatus(arrivalNotice(destination.location, listing.repoRoot));
    if (destination.missingSubdir !== undefined) {
      this.host.showStatus(missingSubdirNotice(destination.missingSubdir, row.kind), 'warning');
    }
  }

  private showForm(): void {
    if (this.busy) return;
    const form: WorktreeFormComponent = new WorktreeFormComponent({
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
    await this.host.worktreeCreation.run(value, {
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
      enter: (location) => this.host.startSessionAt(location),
    });
  }

  private async delete(row: WorktreeRow): Promise<void> {
    const { listing, panel } = this;
    if (this.busy || listing === undefined || panel === undefined) return;
    this.busy = true;
    try {
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
        this.notify({ text: engineMessage(error), tone: 'error' });
        return;
      }
      if (this.mounted !== panel) return;
      if (removal.openSessionIds.length > 0) {
        this.notify({ text: inUseNotice(name), tone: 'warning' });
        return;
      }
      const choice = await this.choose<WorktreeDeleteChoice | 'keep'>((onChoose) =>
        createWorktreeDeletePrompt({ removal, onChoose }),
      );
      if (choice === undefined) return;
      this.mount(panel);
      if (choice === 'keep') {
        this.notify(undefined);
        return;
      }
      this.notify({ text: `Deleting ${name}…`, tone: 'textMuted' });
      try {
        await removeWorktree(this.host.harness, removal, choice, excludeSessionId);
      } catch (error) {
        this.notify(
          isKimiError(error) && error.code === ErrorCodes.WORKTREE_IN_USE
            ? { text: inUseNotice(name), tone: 'warning' }
            : { text: engineMessage(error), tone: 'error' },
        );
        return;
      }
      const refreshed = await this.fetchListing();
      if (refreshed !== undefined) panel.setRows(panelRows(refreshed, this.host.state.appState));
      this.notify({ text: `Deleted ${name}.`, tone: 'success' });
    } finally {
      this.busy = false;
    }
  }

  private async fetchListing(): Promise<WorktreeListing | undefined> {
    try {
      this.listing = await this.host.harness.listWorktrees(this.host.state.appState.workDir);
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
    if (this.mounted !== undefined) this.host.restoreEditor();
  }
}

async function relativeInside(root: string, dir: string): Promise<string | undefined> {
  const direct = relative(root, dir);
  if (!direct.startsWith('..') && !isAbsolute(direct)) return direct;
  const [realRoot, realDir] = await Promise.all([
    realpath(root).catch(() => root),
    realpath(dir).catch(() => dir),
  ]);
  const resolved = relative(realRoot, realDir);
  return resolved.startsWith('..') || isAbsolute(resolved) ? undefined : resolved;
}

function panelRows(
  listing: WorktreeListing,
  appState: Pick<AppState, 'worktree'>,
): WorktreePanelRow[] {
  const sourceRows: WorktreePanelRow[] = listing.bare
    ? []
    : [{ kind: 'source', path: listing.repoRoot, current: appState.worktree === undefined }];
  return [
    ...sourceRows,
    ...listing.worktrees.map((worktree) => ({
      kind: 'worktree' as const,
      worktree,
      current: worktree.path === appState.worktree?.root,
    })),
    { kind: 'new' },
  ];
}

async function destinationFor(
  listing: WorktreeListing,
  row: WorktreePanelTarget,
  appState: Pick<AppState, 'workDir' | 'worktree'>,
): Promise<Destination> {
  const currentRoot = appState.worktree?.root ?? listing.repoRoot;
  const subdir = await relativeInside(currentRoot, appState.workDir);
  const targetRoot = row.kind === 'source' ? listing.repoRoot : row.worktree.path;
  const worktree =
    row.kind === 'source'
      ? undefined
      : { root: row.worktree.path, name: row.worktree.name, repoRoot: listing.repoRoot };
  if (subdir === undefined || subdir === '') {
    return {
      location: { cwd: targetRoot, projectRoot: listing.repoRoot, isGitRepo: true, worktree },
    };
  }
  const cwd = join(targetRoot, subdir);
  return isDirectory(cwd)
    ? { location: { cwd, projectRoot: listing.repoRoot, isGitRepo: true, worktree } }
    : {
        location: { cwd: targetRoot, projectRoot: listing.repoRoot, isGitRepo: true, worktree },
        missingSubdir: subdir,
      };
}

function arrivalNotice(location: WorkLocation, repoRoot: string): string {
  return location.worktree === undefined
    ? `Back in ${abbreviateHome(repoRoot)}`
    : `Now working in worktree ${location.worktree.name}`;
}

function missingSubdirNotice(subdir: string, target: WorktreePanelTarget['kind']): string {
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
