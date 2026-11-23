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
  createSetupFailedPrompt,
  createSetupScriptPrompt,
  createWorktreeFailedPrompt,
  type SetupFailedChoice,
  type SetupScriptChoice,
  type WorktreeFailedChoice,
} from '#/tui/components/dialogs/worktree-choices';
import {
  WorktreeProgressComponent,
  type WorktreeProgress,
  type WorktreeProgressRow,
} from '#/tui/components/messages/worktree-progress';
import { WORKTREE_SETUP_OUTPUT_LINES } from '#/tui/constant/worktree';
import type { TUIState } from '#/tui/tui-state';
import type { WorkLocation } from '#/tui/types';
import { formatErrorMessage } from '#/tui/utils/event-payload';

export interface WorktreeCreationRequest {
  readonly name?: string;
  readonly base?: string;
}

export interface WorktreeCreationOptions {
  readonly onRejected?: (error: unknown) => void;
  readonly onAccepted?: () => void;
  readonly enter?: (location: WorkLocation) => Promise<boolean>;
}

export interface WorktreeRunRecord {
  readonly name: string;
  readonly repoRoot: string;
  setupScriptRan: boolean;
}

export interface WorktreeCreationHost {
  readonly harness: Pick<KimiHarness, 'createWorktree' | 'runWorktreeSetupScript' | 'removeWorktree'>;
  readonly state: Pick<TUIState, 'appState' | 'transcriptContainer' | 'ui'>;
  mountEditorReplacement(panel: Component & Focusable, onDisplaced?: () => void): void;
  restoreEditor(): void;
  applyWorkLocation(location: WorkLocation): Promise<void>;
  showError(message: string): void;
  exitWithError(message: string): void;
  stop(exitCode?: number): Promise<void>;
}

type PlannedWorktree = Extract<WorktreeCreateEvent, { type: 'planned' }>;

export class WorktreeCreationController {
  readonly createdThisRun = new Map<string, WorktreeRunRecord>();
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
    const { workDir, cwd } = this.host.state.appState;
    const block = new WorktreeProgressComponent(() => {
      this.host.state.ui.requestRender();
    });
    this.block = block;
    this.host.state.transcriptContainer.addChild(block);
    this.host.state.ui.requestRender();
    const progress = new ProgressRows(block, () => this.host.state.ui.requestRender());
    try {
      const created = await this.create(request, cwd, workDir, progress, options);
      if (created === undefined) return;
      const record: WorktreeRunRecord = { name: created.worktree.name, repoRoot: created.repoRoot, setupScriptRan: false };
      this.createdThisRun.set(created.worktree.path, record);
      if (created.setupScript !== undefined && !(await this.runSetupScript(created, created.setupScript, record, progress))) {
        return;
      }
      const location: WorkLocation = {
        workDir,
        cwd: created.cwd,
        worktree: { root: created.worktree.path, name: created.worktree.name, repoRoot: created.repoRoot },
      };
      if (options.enter === undefined) {
        await this.host.applyWorkLocation(location);
      } else if (!(await options.enter(location))) {
        progress.stop();
        return;
      }
      const { transcriptContainer } = this.host.state;
      if (!transcriptContainer.children.includes(block)) transcriptContainer.addChild(block);
      progress.finish({
        phase: 'entered',
        name: created.worktree.name,
        sourceDir: created.sourceRoot,
        sourceDirty: created.sourceDirty,
        missingSubdir: created.cwdFallback ? relative(created.sourceRoot, await realpath(cwd).catch(() => cwd)) : undefined,
      });
    } catch (error) {
      if (this.disposed) return;
      progress.stop();
      this.host.showError(formatErrorMessage(error));
    } finally {
      this.running = false;
      this.abort = undefined;
    }
  }

  private async create(
    request: WorktreeCreationRequest,
    cwd: string,
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
        } else if (event.step === 'include' && status === 'running') progress.set({ step: 'include', status, copiedFiles: [] });
      };
      try {
        const created = await this.host.harness.createWorktree(
          { cwd, name: request.name, base: request.base },
          { signal: abort.signal, onEvent },
        );
        this.abort = undefined;
        progress.set({ step: 'include', status: 'done', copiedFiles: created.copiedFiles });
        return created;
      } catch (error) {
        if (this.disposed) return undefined;
        if (abort.signal.aborted || (isKimiError(error) && error.code === ErrorCodes.WORKTREE_CANCELLED)) {
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
          progress.set({ step: 'add', status: 'failed', path: planned.path, head: planned.head, output });
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

  private async runSetupScript(
    created: CreatedWorktree,
    setupScript: string,
    record: WorktreeRunRecord,
    progress: ProgressRows,
  ): Promise<boolean> {
    const script = relative(created.sourceRoot, setupScript);
    const choice = await this.choose<SetupScriptChoice>(
      (onChoose) => createSetupScriptPrompt({ script, sourceDir: created.sourceRoot, onChoose }),
      'skip',
    );
    if (choice === 'skip') return true;
    for (;;) {
      record.setupScriptRan = true;
      const abort = new AbortController();
      this.abort = abort;
      const output = new OutputTail(WORKTREE_SETUP_OUTPUT_LINES);
      const show = (status: 'running' | 'done' | 'failed', exitCode?: number): void => {
        progress.set({ step: 'setup', status, script, output: output.lines, exitCode });
      };
      progress.resume();
      show('running');
      let exitCode: number | undefined;
      try {
        ({ exitCode } = await this.host.harness.runWorktreeSetupScript(
          { worktreePath: created.worktree.path, sourceRoot: created.sourceRoot },
          {
            signal: abort.signal,
            onOutput: (text) => {
              output.push(text);
              show('running');
            },
          },
        ));
      } catch (error) {
        if (this.disposed) return false;
        if (!abort.signal.aborted) {
          output.push(`${messageOf(error)}\n`);
          exitCode = -1;
        }
      }
      this.abort = undefined;
      if (exitCode === 0) {
        show('done');
        return true;
      }
      show('failed', exitCode);
      progress.stop();
      const next = await this.choose<SetupFailedChoice>((onChoose) => createSetupFailedPrompt({ onChoose }), 'continue');
      if (next === 'continue') return true;
      if (next === 'delete') {
        await this.deleteAndExit(created, progress);
        return false;
      }
    }
  }

  private async deleteAndExit(created: CreatedWorktree, progress: ProgressRows): Promise<void> {
    const path = created.worktree.path;
    progress.resume();
    progress.set({ step: 'remove', status: 'running', path });
    try {
      await this.host.harness.removeWorktree({
        repoRoot: created.repoRoot,
        path,
        deleteBranch: false,
        discard: 'all',
      });
    } catch (error) {
      progress.set({ step: 'remove', status: 'failed', path, output: errorOutput(error) });
      progress.stop();
      return;
    }
    this.createdThisRun.delete(path);
    progress.set({ step: 'remove', status: 'done', path });
    progress.stop();
    void this.host.stop(0);
  }

  private choose<T>(build: (onChoose: (choice: T) => void) => Component & Focusable, fallback: T): Promise<T> {
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
    this.rows = index === -1 ? [...this.rows, row] : this.rows.map((existing, i) => (i === index ? row : existing));
    this.render();
  }

  resume(): void {
    this.phase = 'creating';
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

class OutputTail {
  private complete: string[] = [];
  private partial = '';

  constructor(private readonly limit: number) {}

  push(text: string): void {
    const parts = `${this.partial}${text}`.replaceAll('\r\n', '\n').split('\n');
    this.partial = parts.pop() ?? '';
    this.complete = [...this.complete, ...parts.map(visibleLine).filter((line) => line !== '')].slice(-this.limit);
  }

  get lines(): readonly string[] {
    const partial = visibleLine(this.partial);
    return partial === '' ? this.complete : [...this.complete, partial].slice(-this.limit);
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
  return text.split(/\r?\n/).map(visibleLine).filter((line) => line !== '');
}

function checkFailure(error: unknown): string {
  const lines = [`error: ${messageOf(error)}`];
  if (isKimiError(error) && error.code === ErrorCodes.WORKTREE_ALREADY_EXISTS) {
    lines.push('To resume its last session, use kimi -r. To start a new session in it, use /worktree.');
  }
  return lines.join('\n');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
