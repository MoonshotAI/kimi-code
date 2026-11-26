import {
  formatProgramResume,
  formatProgramResumeClear,
  type ProgramResumeSender,
} from '@moonshot-ai/pi-tui';

import { CLI_COMMAND_NAME } from '#/constant/app';
import { UNDO_LIMIT_STATUS_TURN_ID } from '#/tui/constant/kimi-tui';
import type { AppState } from '#/tui/types';

export interface ProgramResumeTerminal {
  write(data: string): void;
}

export interface ProgramResumeTranscriptEntry {
  readonly kind?: string;
  readonly turnId?: string;
}

export interface ProgramResumeState {
  readonly appState: Pick<AppState, 'isReplaying' | 'sessionId' | 'workDir'>;
  readonly transcriptEntries: readonly ProgramResumeTranscriptEntry[];
}

export function hasResumableTranscriptContent(
  entries: readonly ProgramResumeTranscriptEntry[],
): boolean {
  return entries.some(
    (entry) => !(entry.kind === 'status' && entry.turnId === UNDO_LIMIT_STATUS_TURN_ID),
  );
}

export interface ProgramResumeControllerOptions {
  readonly token?: string;
  readonly commandName?: string;
  readonly pid?: number;
  readonly nowSeconds?: () => number;
}

export interface ProgramResumeClearOptions {
  readonly force?: boolean;
}

interface ReportedTarget {
  readonly sessionId: string;
  readonly cwd: string;
}

type ControllerLifecycle =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'active'; readonly token: string }
  | { readonly kind: 'preserved'; readonly token: string }
  | { readonly kind: 'cleared' };

export class ProgramResumeController {
  private lifecycle: ControllerLifecycle;
  private reported: ReportedTarget | undefined;
  private readonly holds = new Set<symbol>();
  private readonly commandName: string;
  private readonly pid: number;
  private readonly nowSeconds: () => number;

  constructor(
    private readonly state: ProgramResumeState,
    private readonly terminal: ProgramResumeTerminal,
    options: ProgramResumeControllerOptions = {},
  ) {
    this.lifecycle =
      options.token !== undefined && options.token.length > 0
        ? { kind: 'active', token: options.token }
        : { kind: 'disabled' };
    this.commandName = options.commandName ?? CLI_COMMAND_NAME;
    this.pid = options.pid ?? process.pid;
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  refresh(): void {
    this.sync(false);
  }

  republish(): void {
    this.sync(true);
  }

  hold(): () => void {
    if (this.lifecycle.kind === 'disabled' || this.lifecycle.kind === 'cleared') {
      return () => {};
    }
    const handle = Symbol();
    this.holds.add(handle);
    return () => {
      if (!this.holds.delete(handle)) return;
      if (this.holds.size === 0) {
        this.refresh();
      }
    };
  }

  async runHeld<T>(fn: () => Promise<T>): Promise<T> {
    const release = this.hold();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  preserveForSignal(): void {
    if (this.lifecycle.kind === 'active') {
      this.lifecycle = { kind: 'preserved', token: this.lifecycle.token };
    }
  }

  clearForExit(options?: ProgramResumeClearOptions): void {
    if (
      this.lifecycle.kind !== 'active' &&
      !(this.lifecycle.kind === 'preserved' && options?.force === true)
    ) {
      return;
    }
    this.clearReported(this.lifecycle.token);
    this.holds.clear();
    this.lifecycle = { kind: 'cleared' };
  }

  private sync(force: boolean): void {
    if (
      this.lifecycle.kind !== 'active' ||
      this.holds.size > 0 ||
      this.state.appState.isReplaying
    ) {
      return;
    }
    const target = this.currentTarget();
    if (target === undefined) {
      this.clearReported(this.lifecycle.token);
      return;
    }
    if (
      !force &&
      this.reported !== undefined &&
      this.reported.sessionId === target.sessionId &&
      this.reported.cwd === target.cwd
    ) {
      return;
    }
    const sequence = formatProgramResume(
      { argv: [this.commandName, '-r', target.sessionId], cwd: target.cwd },
      this.sender(this.lifecycle.token),
    );
    if (sequence === undefined) {
      this.clearReported(this.lifecycle.token);
      return;
    }
    this.terminal.write(sequence);
    this.reported = target;
  }

  private currentTarget(): ReportedTarget | undefined {
    const { sessionId, workDir } = this.state.appState;
    if (sessionId === '' || !hasResumableTranscriptContent(this.state.transcriptEntries)) {
      return undefined;
    }
    return { sessionId, cwd: workDir };
  }

  private clearReported(token: string): void {
    if (this.reported === undefined) return;
    this.terminal.write(formatProgramResumeClear(this.sender(token)));
    this.reported = undefined;
  }

  private sender(token: string): ProgramResumeSender {
    return {
      token,
      pid: this.pid,
      time: this.nowSeconds(),
    };
  }
}
