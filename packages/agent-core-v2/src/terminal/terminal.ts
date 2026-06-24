/**
 * `terminal` domain (cross-cutting) — session-scope terminal service.
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
