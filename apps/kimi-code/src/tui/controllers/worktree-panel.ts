import { basename, isAbsolute, join, relative } from 'node:path';

import { ErrorCodes, isKimiError, type KimiHarness, type WorktreeListing } from '@moonshot-ai/kimi-code-sdk';
import type { Component, Focusable } from '@moonshot-ai/pi-tui';

import {
  createWorktreeDeletePrompt,
  type WorktreeDeleteChoice,
  type WorktreeRemoval,
} from '#/tui/components/dialogs/worktree-choices';
import { WorktreeFormComponent, type WorktreeFormField, type WorktreeFormValue } from '#/tui/components/dialogs/worktree-form';
import {
  WorktreePanelComponent,
  type WorktreePanelNotice,
  type WorktreePanelRow,
  type WorktreePanelTarget,
  type WorktreeRow,
} from '#/tui/components/dialogs/worktree-panel';
import { WORKTREE_PANEL_PAGE_SIZE, WORKTREE_PANEL_RESERVED_ROWS } from '#/tui/constant/worktree';
import type { ColorToken } from '#/tui/theme';
import type { TUIState } from '#/tui/tui-state';
import type { AppState, WorkLocation } from '#/tui/types';
import { abbreviateHome } from '#/tui/utils/home-path';
import { isDirectory } from '#/tui/utils/session-location';

import type { WorktreeCreationController } from './worktree-creation';
import { inspectWorktreeRemoval, removeWorktree } from './worktree-removal';

export interface WorktreePanelHost {
  readonly harness: Pick<KimiHarness, 'listWorktrees' | 'inspectWorktreeRemoval' | 'removeWorktree'>;
  readonly state: Pick<TUIState, 'appState' | 'dockContainer' | 'terminal' | 'ui'>;
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
      pageSize: this.pageSize(),
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
    const destination = await destinationFor(listing, row, this.host.state.appState.workDir);
    this.close();
    if (!(await this.host.startSessionAt(destination.location))) return;
    this.host.showStatus(arrivalNotice(destination.location, sourceRoot(listing, destination.location.workDir)));
    if (destination.missingSubdir !== undefined) this.host.showStatus(missingSubdirNotice(destination.missingSubdir), 'warning');
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
        removal = await inspectWorktreeRemoval(this.host.harness, { repoRoot: listing.repoRoot, worktree: row.worktree, excludeSessionId });
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
      this.listing = await this.host.harness.listWorktrees(this.host.state.appState.cwd);
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

  private choose<T>(build: (onChoose: (choice: T) => void) => Component & Focusable): Promise<T | undefined> {
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

  private pageSize(): number {
    const { dockContainer, terminal } = this.host.state;
    if (dockContainer === undefined) return WORKTREE_PANEL_PAGE_SIZE;
    return Math.max(WORKTREE_PANEL_PAGE_SIZE, terminal.rows - WORKTREE_PANEL_RESERVED_ROWS);
  }
}

function sourceRoot(listing: WorktreeListing, workDir: string): string {
  return projectPath(listing, workDir) === undefined ? workDir : listing.repoRoot;
}

function projectPath(listing: WorktreeListing, workDir: string): string | undefined {
  const path = relative(listing.repoRoot, workDir);
  return path.startsWith('..') || isAbsolute(path) ? undefined : path;
}

function panelRows(listing: WorktreeListing, appState: Pick<AppState, 'workDir' | 'worktree'>): WorktreePanelRow[] {
  return [
    { kind: 'source', path: sourceRoot(listing, appState.workDir), current: appState.worktree === undefined },
    ...listing.worktrees.map((worktree) => ({ kind: 'worktree' as const, worktree, current: worktree.path === appState.worktree?.root })),
    { kind: 'new' },
  ];
}

async function destinationFor(listing: WorktreeListing, row: WorktreePanelTarget, workDir: string): Promise<Destination> {
  if (row.kind === 'source') return { location: { workDir, cwd: workDir } };
  const { path: root, name } = row.worktree;
  const worktree = { root, name, repoRoot: listing.repoRoot };
  const subdir = projectPath(listing, workDir);
  if (subdir === undefined || subdir === '') return { location: { workDir, cwd: root, worktree } };
  const cwd = join(root, subdir);
  return (await isDirectory(cwd))
    ? { location: { workDir, cwd, worktree } }
    : { location: { workDir, cwd: root, worktree }, missingSubdir: subdir };
}

function arrivalNotice(location: WorkLocation, source: string): string {
  return location.worktree === undefined
    ? `Back in ${abbreviateHome(source)}`
    : `Now working in worktree ${location.worktree.name}`;
}

function missingSubdirNotice(subdir: string): string {
  return `${subdir} doesn't exist at this commit, so the session starts at the worktree root.`;
}

function inUseNotice(name: string): string {
  return `${name} is open in another Kimi Code window.`;
}

function fieldAtFault(error: unknown): WorktreeFormField | undefined {
  if (!isKimiError(error)) return undefined;
  if (error.code === ErrorCodes.WORKTREE_INVALID_NAME || error.code === ErrorCodes.WORKTREE_ALREADY_EXISTS) return 'name';
  if (error.code === ErrorCodes.WORKTREE_BASE_NOT_FOUND) return 'base';
  return undefined;
}

function engineMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = isKimiError(error) ? error.details?.['stderr'] : undefined;
  return typeof stderr === 'string' && stderr.trim() !== '' ? `${message}\n${stderr.trim()}` : message;
}
