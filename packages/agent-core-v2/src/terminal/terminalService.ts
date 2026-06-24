/**
 * `terminal` domain (cross-cutting) — `ITerminalService` implementation.
 *
 * Spawns processes via the session kaos and tracks them by id for
 * `write`/`kill`.
 */

import type { KaosProcess } from '@moonshot-ai/kaos';

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ISessionKaosService } from '#/kaos/kaos';
import { ILogService } from '#/log/log';

import { type TerminalHandle, ITerminalService } from './terminal';

export class TerminalService extends Disposable implements ITerminalService {
  declare readonly _serviceBrand: undefined;
  private readonly processes = new Map<string, KaosProcess>();

  constructor(
    @ILogService _log: ILogService,
    @ISessionKaosService private readonly sessionKaos: ISessionKaosService,
  ) {
    super();
  }

  async spawn(cmd: string, args: readonly string[]): Promise<TerminalHandle> {
    const proc = await this.sessionKaos.toolKaos.exec(cmd, ...args);
    const id = String(proc.pid);
    this.processes.set(id, proc);
    return { id };
  }

  write(id: string, data: string): void {
    this.processes.get(id)?.stdin.write(data);
  }

  async kill(id: string): Promise<void> {
    const proc = this.processes.get(id);
    if (proc === undefined) return;
    await proc.kill();
    this.processes.delete(id);
  }
}

registerScopedService(LifecycleScope.Session, ITerminalService, TerminalService, InstantiationType.Delayed, 'terminal');
