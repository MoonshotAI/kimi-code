import { createDecorator } from '../../di';
import type { IDisposable } from '../../di';
import type { Event } from '../../base/common/event';
import type {
  CreateTerminalRequest,
  Terminal,
  TerminalExitMessage,
  TerminalOutputMessage,
} from '@moonshot-ai/protocol';

export type TerminalFrame = TerminalOutputMessage | TerminalExitMessage;

export interface TerminalAttachSink {
  readonly id: string;
  send(frame: TerminalFrame): void;
}

export interface TerminalAttachOptions {
  readonly sinceSeq?: number;
}

export interface TerminalSpawnOptions {
  readonly cwd: string;
  readonly shell: string;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalProcess {
  readonly onData: Event<string>;
  readonly onExit: Event<{ exitCode: number | null }>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface TerminalBackend {
  spawn(options: TerminalSpawnOptions): Promise<TerminalProcess>;
}

export interface TerminalServiceOptions {
  readonly backend?: TerminalBackend;
  readonly defaultShell?: string;
  readonly defaultCols?: number;
  readonly defaultRows?: number;
  readonly maxBufferedFrames?: number;
}

export interface ITerminalService {
  readonly _serviceBrand: undefined;

  create(sessionId: string, input: CreateTerminalRequest): Promise<Terminal>;

  list(sessionId: string): Promise<readonly Terminal[]>;

  get(sessionId: string, terminalId: string): Promise<Terminal>;

  attach(
    sessionId: string,
    terminalId: string,
    sink: TerminalAttachSink,
    options?: TerminalAttachOptions,
  ): Promise<{ replayed: number }>;

  detach(sessionId: string, terminalId: string, sinkId: string): void;

  detachAllForSink(sinkId: string): void;

  write(sessionId: string, terminalId: string, data: string): Promise<void>;

  resize(sessionId: string, terminalId: string, cols: number, rows: number): Promise<void>;

  close(sessionId: string, terminalId: string): Promise<{ closed: true }>;
}

export const ITerminalService = createDecorator<ITerminalService>('terminalService');

export class TerminalNotFoundError extends Error {
  readonly sessionId: string;
  readonly terminalId: string;

  constructor(sessionId: string, terminalId: string) {
    super(`terminal ${terminalId} does not exist in session ${sessionId}`);
    this.name = 'TerminalNotFoundError';
    this.sessionId = sessionId;
    this.terminalId = terminalId;
  }
}

export function disposeAll(items: Iterable<IDisposable>): void {
  for (const item of items) {
    item.dispose();
  }
}
