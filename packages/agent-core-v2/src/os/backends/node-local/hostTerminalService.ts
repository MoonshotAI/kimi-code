/**
 * `terminal` domain (L6) — `IHostTerminalService` implementation.
 *
 * App-scoped OS terminal process factory backed by `node-pty`. It spawns and
 * tracks every `TerminalProcess` so the whole process-wide PTY layer can be
 * torn down on disposal. It has no session, workspace, or buffering concerns;
 * those live in the Session-scoped `ISessionTerminalService`.
 *
 * `node-pty` is loaded lazily so merely importing this module (for example in
 * tests that override the service with a fake) does not require the native
 * module to be built or resolvable.
 */

import type { IPty } from 'node-pty';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IHostTerminalService, type TerminalProcess, type TerminalSpawnOptions } from '#/os/interface/terminal';

export class HostTerminalService extends Disposable implements IHostTerminalService {
  declare readonly _serviceBrand: undefined;

  private readonly processes = new Set<TerminalProcess>();

  async spawn(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    const pty = await import('node-pty');
    const proc: IPty = pty.spawn(options.shell, [], {
      name: 'xterm-256color',
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env: globalThis.process.env,
    });
    const terminalProcess: TerminalProcess = {
      onProcessData: (listener) => proc.onData(listener),
      onProcessExit: (listener) => proc.onExit((event) => listener({ exitCode: event.exitCode })),
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: () => proc.kill(),
    };
    this.processes.add(terminalProcess);
    return terminalProcess;
  }

  override dispose(): void {
    for (const process of this.processes) {
      try {
        process.kill();
      } catch {
      }
    }
    this.processes.clear();
    super.dispose();
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostTerminalService,
  HostTerminalService,
  InstantiationType.Delayed,
  'terminal',
);
