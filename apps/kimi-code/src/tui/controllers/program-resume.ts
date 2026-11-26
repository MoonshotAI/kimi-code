import { isAbsolute } from 'node:path';

import {
  formatProgramResume,
  formatProgramResumeClear,
} from '@moonshot-ai/pi-tui';

import { detectNativeInstall } from '#/cli/update/source';
import { CLI_COMMAND_NAME } from '#/constant/app';
import { UNDO_LIMIT_STATUS_TURN_ID } from '#/tui/constant/kimi-tui';
import type { AppState } from '#/tui/types';
import { resolveCommandPath, resolveTrustedExecutable } from '#/utils/process/resolve-command';

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
  readonly isNativeInstall?: () => boolean;
  readonly execPath?: string;
}

export interface ProgramResumeClearOptions {
  readonly force?: boolean;
}

interface ReportedTarget {
  readonly program: string;
  readonly sessionId: string;
  readonly cwd: string;
}

type SyncedRecord =
  | { readonly kind: 'none'; readonly pendingCatchup: boolean }
  | {
      readonly kind: 'reported';
      readonly target: ReportedTarget;
      readonly pendingCatchup: boolean;
    };

interface CachedWindowsProgram {
  readonly cwd: string;
  readonly program: string | undefined;
}

type ControllerLifecycle =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'active'; readonly token: string }
  | { readonly kind: 'preserved'; readonly token: string }
  | { readonly kind: 'cleared' };

export class ProgramResumeController {
  private lifecycle: ControllerLifecycle;
  private synced: SyncedRecord = { kind: 'none', pendingCatchup: false };
  private lastSentTime: number | undefined;
  private cachedWindowsProgram: CachedWindowsProgram | undefined;
  private readonly holds = new Set<symbol>();
  private readonly commandName: string;
  private readonly pid: number;
  private readonly nowSeconds: () => number;
  private readonly isNativeInstall: () => boolean;
  private readonly execPath: string;

  constructor(
    private readonly state: ProgramResumeState,
    private readonly terminal: ProgramResumeTerminal,
    options: ProgramResumeControllerOptions = {},
  ) {
    const rawPid = options.pid ?? process.pid;
    const validPid = Number.isInteger(rawPid) && rawPid > 0 ? rawPid : undefined;
    this.lifecycle =
      options.token !== undefined && options.token.length > 0 && validPid !== undefined
        ? { kind: 'active', token: options.token }
        : { kind: 'disabled' };
    this.commandName = options.commandName ?? CLI_COMMAND_NAME;
    this.pid = validPid ?? 0;
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.isNativeInstall = options.isNativeInstall ?? detectNativeInstall;
    this.execPath = options.execPath ?? process.execPath;
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
    this.syncClear(this.lifecycle.token, true);
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
    const target = this.currentTarget(force);
    if (target === undefined) {
      this.syncClear(this.lifecycle.token, force);
      return;
    }
    const sameTarget =
      this.synced.kind === 'reported' &&
      this.synced.target.program === target.program &&
      this.synced.target.sessionId === target.sessionId &&
      this.synced.target.cwd === target.cwd;
    if (!force && sameTarget && !(this.synced.pendingCatchup && this.isClockCaughtUp())) {
      return;
    }
    const stamp = this.nextTimestamp();
    if (stamp === undefined) {
      return;
    }
    const sequence = formatProgramResume(
      { argv: [target.program, '-r', target.sessionId], cwd: target.cwd },
      { token: this.lifecycle.token, pid: this.pid, time: stamp.time },
    );
    if (sequence === undefined) {
      this.syncClear(this.lifecycle.token, force);
      return;
    }
    this.terminal.write(sequence);
    this.lastSentTime = stamp.time;
    this.synced = { kind: 'reported', target, pendingCatchup: !stamp.caughtUp };
  }

  private currentTarget(force: boolean): ReportedTarget | undefined {
    const { sessionId, workDir } = this.state.appState;
    if (
      sessionId === '' ||
      !isAbsolute(workDir) ||
      !hasResumableTranscriptContent(this.state.transcriptEntries)
    ) {
      return undefined;
    }
    const program = this.resolveProgram(workDir, force);
    if (program === undefined) {
      return undefined;
    }
    return { program, sessionId, cwd: workDir };
  }

  private resolveProgram(cwd: string, force: boolean): string | undefined {
    if (process.platform !== 'win32') {
      return this.commandName;
    }
    if (!force && this.cachedWindowsProgram?.cwd === cwd) {
      return this.cachedWindowsProgram.program;
    }
    const program = this.lookupWindowsProgram(cwd);
    this.cachedWindowsProgram = { cwd, program };
    return program;
  }

  private lookupWindowsProgram(cwd: string): string | undefined {
    if (isAbsolute(this.commandName)) {
      return resolveTrustedExecutable(this.commandName, cwd);
    }
    const fromPath = resolveCommandPath(this.commandName, cwd);
    if (fromPath !== undefined) {
      return fromPath;
    }
    if (this.commandName === CLI_COMMAND_NAME && this.isNativeInstall()) {
      return resolveTrustedExecutable(this.execPath, cwd);
    }
    return undefined;
  }

  private syncClear(token: string, force: boolean): void {
    if (this.synced.kind === 'none') {
      if (!this.synced.pendingCatchup) return;
      if (!force && !this.isClockCaughtUp()) return;
    }
    const stamp = this.nextTimestamp();
    if (stamp === undefined) return;
    this.terminal.write(formatProgramResumeClear({ token, pid: this.pid, time: stamp.time }));
    this.lastSentTime = stamp.time;
    this.synced = { kind: 'none', pendingCatchup: !stamp.caughtUp };
  }

  private nextTimestamp(): { readonly time: number; readonly caughtUp: boolean } | undefined {
    const raw = this.nowSeconds();
    if (!Number.isFinite(raw)) return undefined;
    const wallTime = Math.floor(raw);
    if (wallTime < 1) return undefined;
    if (this.lastSentTime !== undefined && wallTime < this.lastSentTime) {
      return { time: this.lastSentTime, caughtUp: false };
    }
    return { time: wallTime, caughtUp: true };
  }

  private isClockCaughtUp(): boolean {
    if (this.lastSentTime === undefined) return true;
    const raw = this.nowSeconds();
    return Number.isFinite(raw) && Math.floor(raw) >= this.lastSentTime;
  }
}
