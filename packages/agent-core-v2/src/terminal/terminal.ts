/**
 * `terminal` domain (cross-cutting) — session-scope terminal service.
 *
 * Defines the public contract of terminal management: the `TerminalHandle`
 * model and the `ITerminalService` used to spawn processes, write to stdin,
 * and kill terminals. Session-scoped — one service per session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface TerminalHandle {
  readonly id: string;
}

export interface ITerminalService {
  readonly _serviceBrand: undefined;
  spawn(cmd: string, args: readonly string[]): Promise<TerminalHandle>;
  write(id: string, data: string): void;
  kill(id: string): Promise<void>;
}

export const ITerminalService: ServiceIdentifier<ITerminalService> =
  createDecorator<ITerminalService>('terminalService');
