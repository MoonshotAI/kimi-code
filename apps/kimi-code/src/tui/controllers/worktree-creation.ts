import { realpath } from 'node:fs/promises';
import { relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import {
  ErrorCodes,
  isKimiError,
  type CreatedWorktree,
  type KimiHarness,
  type WorktreeCreateEvent,
  type WorktreeCreateStep,
} from '@moonshot-ai/kimi-code-sdk';
import type { Component, Focusable } from '@moonshot-ai/pi-tui';

import {
  createWorktreeFailedPrompt,
  type WorktreeFailedChoice,
} from '#/tui/components/dialogs/worktree-choices';
import type { WorktreeSessionAction } from '#/tui/components/dialogs/worktree-form';
import {
  WorktreeProgressComponent,
  type WorktreeProgress,
  type WorktreeProgressRow,
} from '#/tui/components/messages/worktree-progress';
import type { TUIState } from '#/tui/tui-state';
import type { WorkLocation } from '#/tui/types';
import { formatErrorMessage } from '#/tui/utils/event-payload';
import { isDirectory } from '#/utils/session-directory';

export interface WorktreeCreationRequest {
  readonly name?: string;
  readonly base?: string;
  readonly mode?: WorktreeSessionAction;
}

export interface WorktreeCreationOptions {
  readonly beforeCreate?: () => Promise<void> | void;
  readonly onRejected?: (error: unknown) => void;
  readonly onAccepted?: () => void;
  readonly enter?: (location: WorkLocation) => Promise<boolean>;
}

export interface WorktreeCreationHost {
  readonly harness: Pick<KimiHarness, 'createWorktree'>;
  readonly state: Pick<TUIState, 'appState' | 'transcriptContainer' | 'ui'>;
  mountEditorReplacement(panel: Component & Focusable, onDisplaced?: () => void): void;
  restoreEditor(): void;
  applyWorkLocation(location: WorkLocation): Promise<void>;
  showError(message: string): void;
  exitWithError(message: string): void;
}

type PlannedWorktree = Extract<WorktreeCreateEvent, { type: 'planned' }>;

export class WorktreeCreationController {
  private running = false;
  private disposed = false;
  private abort: AbortController | undefined;
  private block: WorktreeProgressComponent | undefined;

  constructor(private readonly host: WorktreeCreationHost) {}

  get busy(): boolean {
    return this.running;
  }

  cancel(): boolean {
    const abort = this.abort;
    if (abort === undefined || abort.signal.aborted) return false;
    abort.abort();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    this.block?.dispose();
  }

  private discardBlock(): void {
    const block = this.block;
    if (block === undefined) return;
    block.dispose();
    this.host.state.transcriptContainer.removeChild(block);
    this.host.state.ui.requestRender();
  }

  async run(request: WorktreeCreationRequest, options: WorktreeCreationOptions = {}): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    const { workDir, projectRoot } = this.host.state.appState;
    const sourceDir = isDirectory(workDir) || projectRoot === undefined ? workDir : projectRoot;
    try {
      if (options.beforeCreate !== undefined) {
        try {
          await options.beforeCreate();
        } catch (error) {
          if (options.onRejected !== undefined) {
            options.onRejected(error);
          } else {
            this.host.showError(formatErrorMessage(error));
          }
          return;
        }
      }

      const block = new WorktreeProgressComponent(() => {
        this.host.state.ui.requestRender();
      });
      this.block = block;
      this.host.state.transcriptContainer.addChild(block);
      this.host.state.ui.requestRender();
      const progress = new ProgressRows(block, () => this.host.state.ui.requestRender());
      try {
        const created = await this.create(request, sourceDir, progress, options);
        if (created === undefined) return;
        const location: WorkLocation = {
          cwd: created.cwd,
          projectRoot: created.repoRoot,
          isGitRepo: true,
          worktree: {
            root: created.worktree.path,
            name: created.worktree.name,
            repoRoot: created.repoRoot,
          },
        };
        if (options.enter === undefined) {
          await this.host.applyWorkLocation(location);
        } else {
          let entered = false;
          try {
            entered = await options.enter(location);
          } catch (error) {
            if (this.disposed) return;
            if (request.mode === 'move') {
              const { transcriptContainer } = this.host.state;
              if (!transcriptContainer.children.includes(block)) transcriptContainer.addChild(block);
              progress.finish({
                phase: 'move_failed',
                name: created.worktree.name,
                sourceDir: created.sourceRoot,
                reason: formatErrorMessage(error),
              });
              return;
            }
            throw error;
          }
          if (!entered) {
            progress.stop();
            return;
          }
        }
        const { transcriptContainer } = this.host.state;
        if (!transcriptContainer.children.includes(block)) transcriptContainer.addChild(block);
        progress.finish({
          phase: request.mode === 'move' ? 'moved' : 'entered',
          name: created.worktree.name,
          sourceDir: created.sourceRoot,
          sourceDirty: created.sourceDirty,
          missingSubdir: created.cwdFallback
            ? relative(created.sourceRoot, await realpath(sourceDir).catch(() => sourceDir))
            : undefined,
        });
      } catch (error) {
        if (this.disposed) return;
        progress.stop();
        this.host.showError(formatErrorMessage(error));
      }
    } finally {
      this.running = false;
      this.abort = undefined;
    }
  }

  private async create(
    request: WorktreeCreationRequest,
    sourceDir: string,
    progress: ProgressRows,
    options: WorktreeCreationOptions,
  ): Promise<CreatedWorktree | undefined> {
    for (;;) {
      const abort = new AbortController();
      this.abort = abort;
      progress.reset();
      const seen: { step: WorktreeCreateStep; planned?: PlannedWorktree } = { step: 'check' };
      const onEvent = (event: WorktreeCreateEvent): void => {
        if (event.type === 'planned') {
          seen.planned = event;
          progress.name(event.name);
          options.onAccepted?.();
          return;
        }
        if (event.type !== 'step') return;
        seen.step = event.step;
        const status = event.status === 'started' ? 'running' : 'done';
        if (event.step === 'check') progress.set({ step: 'check', status, sourceDir });
        else if (event.step === 'add' && seen.planned !== undefined) {
          progress.set({ step: 'add', status, path: seen.planned.path, head: seen.planned.head });
        } else if (event.step === 'include' && status === 'running') {
          progress.set({ step: 'include', status, copiedFiles: [] });
        }
      };
      try {
        const created = await this.host.harness.createWorktree(
          { cwd: sourceDir, name: request.name, base: request.base },
          { signal: abort.signal, onEvent },
        );
        this.abort = undefined;
        progress.set({ step: 'include', status: 'done', copiedFiles: created.copiedFiles });
        return created;
      } catch (error) {
        if (this.disposed) return undefined;
        if (
          abort.signal.aborted ||
          (isKimiError(error) && error.code === ErrorCodes.WORKTREE_CANCELLED)
        ) {
          progress.finish({ phase: 'cancelled', sourceDir });
          return undefined;
        }
        const output = errorOutput(error);
        const { step, planned } = seen;
        if (step === 'check' && options.onRejected !== undefined) {
          this.discardBlock();
          options.onRejected(error);
          return undefined;
        }
        if (step === 'check') {
          progress.set({ step: 'check', status: 'failed', sourceDir, output });
          progress.stop();
          this.host.exitWithError(checkFailure(error));
          return undefined;
        }
        if (step === 'add' && planned !== undefined) {
          progress.set({
            step: 'add',
            status: 'failed',
            path: planned.path,
            head: planned.head,
            output,
          });
        } else {
          progress.set({ step: 'include', status: 'failed', copiedFiles: [], output });
        }
        progress.stop();
        this.abort = undefined;
        const choice = await this.choose<WorktreeFailedChoice>(
          (onChoose) => createWorktreeFailedPrompt({ sourceDir, onChoose }),
          'stay',
        );
        if (choice === 'stay') return undefined;
      }
    }
  }

  private choose<T>(
    build: (onChoose: (choice: T) => void) => Component & Focusable,
    fallback: T,
  ): Promise<T> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (choice: T, restore: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(choice);
        if (restore) this.host.restoreEditor();
      };
      this.host.mountEditorReplacement(
        build((choice) => {
          finish(choice, true);
        }),
        () => {
          finish(fallback, false);
        },
      );
    });
  }
}

class ProgressRows {
  private title: string | undefined;
  private rows: WorktreeProgressRow[] = [];
  private phase: 'creating' | 'stopped' = 'creating';

  constructor(
    private readonly block: WorktreeProgressComponent,
    private readonly requestRender: () => void,
  ) {}

  reset(): void {
    this.title = undefined;
    this.rows = [];
    this.phase = 'creating';
    this.render();
  }

  name(name: string): void {
    this.title = name;
    this.render();
  }

  set(row: WorktreeProgressRow): void {
    const index = this.rows.findIndex((existing) => existing.step === row.step);
    this.rows =
      index === -1
        ? [...this.rows, row]
        : this.rows.map((existing, i) => (i === index ? row : existing));
    this.render();
  }

  stop(): void {
    this.phase = 'stopped';
    this.render();
  }

  finish(progress: WorktreeProgress): void {
    this.block.update(progress);
    this.requestRender();
  }

  private render(): void {
    this.finish({ phase: this.phase, name: this.title, rows: this.rows });
  }
}

function visibleLine(line: string): string {
  return stripVTControlCharacters(line.slice(line.lastIndexOf('\r') + 1))
    .replaceAll('\t', '  ')
    .trimEnd();
}

function errorOutput(error: unknown): string[] {
  const stderr = isKimiError(error) ? error.details?.['stderr'] : undefined;
  const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : messageOf(error);
  return text
    .split(/\r?\n/)
    .map(visibleLine)
    .filter((line) => line !== '');
}

function checkFailure(error: unknown): string {
  const lines = [`error: ${messageOf(error)}`];
  if (isKimiError(error) && error.code === ErrorCodes.WORKTREE_ALREADY_EXISTS) {
    lines.push(
      'To resume its last session, use kimi -r. To start a new session in it, use /worktree.',
    );
  }
  return lines.join('\n');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
