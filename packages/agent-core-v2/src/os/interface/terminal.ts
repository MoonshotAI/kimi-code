/**
 * `terminal` domain (L6) — interactive terminal (PTY) contract.
 *
 * Defines the App-scoped `IHostTerminalService` that owns the actual OS terminal
 * processes and the low-level process/stream primitives (`TerminalProcess`,
 * `TerminalSpawnOptions`, `TerminalAttachSink`, `TerminalFrame`) used to wire
 * terminal I/O to a transport. The session-scoped facade
 * (`ISessionTerminalService`) lives in `src/session/terminal` and is the
 * surface most business code and the edge consume.
 *
 * Wire types (`Terminal`, `CreateTerminalRequest`, frame messages) are sourced
 * from `@moonshot-ai/protocol`.
 */

import type {
  CreateTerminalRequest,
  Terminal,
  TerminalExitMessage,
  TerminalOutputMessage,
} from '@moonshot-ai/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export type { CreateTerminalRequest, Terminal, TerminalExitMessage, TerminalOutputMessage };

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
  readonly onProcessData: Event<string>;
  readonly onProcessExit: Event<{ exitCode: number | null }>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface IHostTerminalService {
  readonly _serviceBrand: undefined;

  spawn(options: TerminalSpawnOptions): Promise<TerminalProcess>;
}

export const IHostTerminalService: ServiceIdentifier<IHostTerminalService> =
  createDecorator<IHostTerminalService>('hostTerminalService');
