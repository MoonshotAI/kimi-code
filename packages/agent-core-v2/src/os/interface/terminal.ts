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
 * Wire types (`Terminal`, `CreateTerminalRequest`, frame messages) are defined
 * here — the terminal REST schemas as zod, the attach-frame messages as plain
 * types.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import { isoDateTimeSchema } from '#/_base/utils/isoDateTime';

const relativeCwdSchema = z
  .string()
  .min(1)
  .refine((value) => !isAbsolutePath(value), 'cwd must be relative to the session workspace');

export const terminalStatusSchema = z.enum(['running', 'exited']);
export type TerminalStatus = z.infer<typeof terminalStatusSchema>;

export const terminalSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  shell: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  status: terminalStatusSchema,
  created_at: isoDateTimeSchema,
  exited_at: isoDateTimeSchema.optional(),
  exit_code: z.number().int().nullable().optional(),
});
export type Terminal = z.infer<typeof terminalSchema>;

export const createTerminalRequestSchema = z.object({
  cwd: relativeCwdSchema.optional(),
  shell: z.string().min(1).optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});
export type CreateTerminalRequest = z.infer<typeof createTerminalRequestSchema>;

export interface TerminalOutputMessage {
  type: 'terminal_output';
  seq: number;
  session_id: string;
  terminal_id: string;
  timestamp: string;
  payload: { data: string };
}

export interface TerminalExitMessage {
  type: 'terminal_exit';
  session_id: string;
  terminal_id: string;
  timestamp: string;
  payload: { exit_code?: number | null | undefined };
}

export type TerminalFrame = TerminalOutputMessage | TerminalExitMessage;

function isAbsolutePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

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
