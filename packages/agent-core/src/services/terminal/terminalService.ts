import { promises as fs } from 'node:fs';
import os from 'node:os';

import { Disposable, registerSingleton, SyncDescriptor } from '../../di';
import type { IDisposable } from '../../di';
import type {
  CreateTerminalRequest,
  Terminal,
  TerminalExitMessage,
  TerminalOutputMessage,
} from '@moonshot-ai/protocol';
import { ulid } from 'ulid';

import { resolveSafePath } from '../fs/fsPathSafety';
import { ISessionService } from '../session/session';
import {
  disposeAll,
  ITerminalService,
  TerminalNotFoundError,
  type TerminalAttachOptions,
  type TerminalAttachSink,
  type TerminalBackend,
  type TerminalFrame,
  type TerminalProcess,
  type TerminalServiceOptions,
  type TerminalSpawnOptions,
} from './terminal';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_MAX_BUFFERED_FRAMES = 2000;

interface TerminalRecord {
  terminal: Terminal;
  process: TerminalProcess;
  sinks: Map<string, TerminalAttachSink>;
  buffer: TerminalFrame[];
  nextSeq: number;
  disposables: IDisposable[];
  closed: boolean;
}

export class TerminalService extends Disposable implements ITerminalService {
  readonly _serviceBrand: undefined;

  private readonly backend: TerminalBackend;
  private readonly defaultShell: string;
  private readonly defaultCols: number;
  private readonly defaultRows: number;
  private readonly maxBufferedFrames: number;
  private readonly records = new Map<string, TerminalRecord>();

  constructor(
    options: TerminalServiceOptions = {},
    @ISessionService private readonly sessionService: ISessionService,
  ) {
    super();
    this.backend = options.backend ?? new NodePtyTerminalBackend();
    this.defaultShell = options.defaultShell ?? defaultShell();
    this.defaultCols = options.defaultCols ?? DEFAULT_COLS;
    this.defaultRows = options.defaultRows ?? DEFAULT_ROWS;
    this.maxBufferedFrames = options.maxBufferedFrames ?? DEFAULT_MAX_BUFFERED_FRAMES;
  }

  async create(sessionId: string, input: CreateTerminalRequest): Promise<Terminal> {
    const session = await this.sessionService.get(sessionId);
    const cwd =
      input.cwd === undefined
        ? await fs.realpath(session.metadata.cwd)
        : (await resolveSafePath(session.metadata.cwd, input.cwd)).absolute;
    const shell = input.shell ?? this.defaultShell;
    const cols = input.cols ?? this.defaultCols;
    const rows = input.rows ?? this.defaultRows;
    const process = await this.backend.spawn({ cwd, shell, cols, rows });
    const terminal: Terminal = {
      id: `term_${ulid()}`,
      session_id: sessionId,
      cwd,
      shell,
      cols,
      rows,
      status: 'running',
      created_at: new Date().toISOString(),
    };
    const record: TerminalRecord = {
      terminal,
      process,
      sinks: new Map(),
      buffer: [],
      nextSeq: 0,
      disposables: [],
      closed: false,
    };
    record.disposables.push(
      process.onData((data) => this.onData(record, data)),
      process.onExit((event) => this.onExit(record, event.exitCode)),
    );
    this.records.set(recordKey(sessionId, terminal.id), record);
    return { ...terminal };
  }

  async list(sessionId: string): Promise<readonly Terminal[]> {
    await this.sessionService.get(sessionId);
    return [...this.records.values()]
      .filter((record) => record.terminal.session_id === sessionId)
      .map((record) => ({ ...record.terminal }));
  }

  async get(sessionId: string, terminalId: string): Promise<Terminal> {
    return { ...(await this.requireRecord(sessionId, terminalId)).terminal };
  }

  async attach(
    sessionId: string,
    terminalId: string,
    sink: TerminalAttachSink,
    options: TerminalAttachOptions = {},
  ): Promise<{ replayed: number }> {
    const record = await this.requireRecord(sessionId, terminalId);
    record.sinks.set(sink.id, sink);
    const sinceSeq = options.sinceSeq ?? 0;
    const replay = record.buffer.filter((frame) => frameSeq(frame) > sinceSeq);
    for (const frame of replay) {
      sink.send(frame);
    }
    return { replayed: replay.length };
  }

  detach(sessionId: string, terminalId: string, sinkId: string): void {
    this.records.get(recordKey(sessionId, terminalId))?.sinks.delete(sinkId);
  }

  detachAllForSink(sinkId: string): void {
    for (const record of this.records.values()) {
      record.sinks.delete(sinkId);
    }
  }

  async write(sessionId: string, terminalId: string, data: string): Promise<void> {
    const record = await this.requireRecord(sessionId, terminalId);
    record.process.write(data);
  }

  async resize(
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    const record = await this.requireRecord(sessionId, terminalId);
    record.terminal = { ...record.terminal, cols, rows };
    record.process.resize(cols, rows);
  }

  async close(sessionId: string, terminalId: string): Promise<{ closed: true }> {
    const record = await this.requireRecord(sessionId, terminalId);
    if (!record.closed) {
      record.closed = true;
      record.process.kill();
      this.markExited(record, null);
    }
    return { closed: true };
  }

  override dispose(): void {
    for (const record of this.records.values()) {
      disposeAll(record.disposables);
      try {
        record.process.kill();
      } catch {
      }
    }
    this.records.clear();
    super.dispose();
  }

  private async requireRecord(
    sessionId: string,
    terminalId: string,
  ): Promise<TerminalRecord> {
    await this.sessionService.get(sessionId);
    const record = this.records.get(recordKey(sessionId, terminalId));
    if (record === undefined) {
      throw new TerminalNotFoundError(sessionId, terminalId);
    }
    return record;
  }

  private onData(record: TerminalRecord, data: string): void {
    const frame: TerminalOutputMessage = {
      type: 'terminal_output',
      seq: ++record.nextSeq,
      session_id: record.terminal.session_id,
      terminal_id: record.terminal.id,
      timestamp: new Date().toISOString(),
      payload: { data },
    };
    this.pushFrame(record, frame);
  }

  private onExit(record: TerminalRecord, exitCode: number | null): void {
    this.markExited(record, exitCode);
  }

  private markExited(record: TerminalRecord, exitCode: number | null): void {
    if (record.terminal.status === 'exited') return;
    record.closed = true;
    record.terminal = {
      ...record.terminal,
      status: 'exited',
      exited_at: new Date().toISOString(),
      exit_code: exitCode,
    };
    const frame: TerminalExitMessage = {
      type: 'terminal_exit',
      session_id: record.terminal.session_id,
      terminal_id: record.terminal.id,
      timestamp: new Date().toISOString(),
      payload: { exit_code: exitCode },
    };
    this.pushFrame(record, frame);
    disposeAll(record.disposables);
    record.disposables = [];
  }

  private pushFrame(record: TerminalRecord, frame: TerminalFrame): void {
    record.buffer.push(frame);
    if (record.buffer.length > this.maxBufferedFrames) {
      record.buffer.splice(0, record.buffer.length - this.maxBufferedFrames);
    }
    for (const sink of record.sinks.values()) {
      sink.send(frame);
    }
  }
}

export class NodePtyTerminalBackend implements TerminalBackend {
  async spawn(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    const pty = await import('node-pty');
    const proc = pty.spawn(options.shell, [], {
      name: 'xterm-256color',
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env: process.env,
    });
    return {
      onData: (listener) => proc.onData(listener),
      onExit: (listener) =>
        proc.onExit((event) => listener({ exitCode: event.exitCode })),
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: () => proc.kill(),
    };
  }
}

function recordKey(sessionId: string, terminalId: string): string {
  return `${sessionId}\0${terminalId}`;
}

function frameSeq(frame: TerminalFrame): number {
  return frame.type === 'terminal_output' ? frame.seq : Number.MAX_SAFE_INTEGER;
}

function defaultShell(): string {
  // Use `||` (not `??`): an EMPTY $SHELL (set but blank, as some daemon/launchd
  // envs leave it) must still fall back, or node-pty spawns an empty path and
  // fails with "posix_spawnp failed".
  return process.env['SHELL'] || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/sh');
}

registerSingleton(
  ITerminalService,
  new SyncDescriptor(TerminalService, [{}], false),
);
