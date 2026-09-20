import { randomUUID } from 'node:crypto';

import { Emitter } from '@moonshot-ai/agent-core-v2/_base/event';
import type {
  IHostTerminalService,
  TerminalProcess,
  TerminalSpawnOptions,
} from '@moonshot-ai/agent-core-v2/os/interface/terminal';

import {
  PROCESS_EXITED_METHOD,
  PROCESS_OUTPUT_METHOD,
  PROCESS_RESIZE_METHOD,
  PROCESS_START_METHOD,
  PROCESS_TERMINATE_METHOD,
  PROCESS_WRITE_METHOD,
  type ProcessExitedNotification,
  type ProcessOutputNotification,
} from '#/protocol/methods';
import { RequestTimeoutError, type RemoteExecConnection } from './connection';
import { toRemoteProcessError } from './remoteProcess';

class RemoteTerminalProcess implements TerminalProcess {
  private readonly dataEmitter = new Emitter<string>();
  private readonly exitEmitter = new Emitter<{ exitCode: number | null }>();
  private readonly decoder = new TextDecoder('utf-8');
  private writeChain: Promise<void> = Promise.resolve();
  private exited = false;
  readonly onProcessData = this.dataEmitter.event;
  readonly onProcessExit = this.exitEmitter.event;

  constructor(
    private readonly connection: RemoteExecConnection,
    private readonly processId: string,
    private readonly diagnostic: (line: string) => void,
  ) {}

  onOutput(chunk: Uint8Array): void {
    this.dataEmitter.fire(this.decoder.decode(chunk, { stream: true }));
  }

  onExited(exitCode: number): void {
    if (this.exited) return;
    this.exited = true;
    const tail = this.decoder.decode();
    if (tail.length > 0) {
      this.dataEmitter.fire(tail);
    }
    this.exitEmitter.fire({ exitCode });
    this.dataEmitter.dispose();
    this.exitEmitter.dispose();
  }

  write(data: string): void {
    const writeId = randomUUID();
    this.writeChain = this.writeChain.then(async () => {
      try {
        await this.connection.call(PROCESS_WRITE_METHOD, {
          processId: this.processId,
          chunkBase64: Buffer.from(data, 'utf8').toString('base64'),
          writeId,
        });
      } catch (error) {
        this.diagnostic(`terminal write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  resize(cols: number, rows: number): void {
    this.connection
      .call(PROCESS_RESIZE_METHOD, { processId: this.processId, cols, rows })
      .catch((error: unknown) => {
        this.diagnostic(`terminal resize failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  kill(): void {
    this.connection
      .call(PROCESS_TERMINATE_METHOD, { processId: this.processId })
      .catch((error: unknown) => {
        this.diagnostic(`terminal kill failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }
}

export class RemoteTerminalService implements IHostTerminalService {
  declare readonly _serviceBrand: undefined;

  private readonly processes = new Map<string, RemoteTerminalProcess>();

  constructor(
    private readonly connection: RemoteExecConnection,
    private readonly diagnostic: (line: string) => void = () => {},
  ) {
    connection.onNotification(PROCESS_OUTPUT_METHOD, (params) => {
      const notification = params as ProcessOutputNotification;
      if (notification.stream !== 'pty') return;
      this.processes
        .get(notification.processId)
        ?.onOutput(new Uint8Array(Buffer.from(notification.chunkBase64, 'base64')));
    });
    connection.onNotification(PROCESS_EXITED_METHOD, (params) => {
      const notification = params as ProcessExitedNotification;
      const proc = this.processes.get(notification.processId);
      if (proc === undefined) return;
      proc.onExited(notification.exitCode);
      this.processes.delete(notification.processId);
    });
    connection.onDidClose(() => {
      for (const proc of this.processes.values()) {
        proc.onExited(-1);
      }
    });
  }

  async spawn(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    const processId = randomUUID();
    const proc = new RemoteTerminalProcess(this.connection, processId, this.diagnostic);
    this.processes.set(processId, proc);
    try {
      await this.connection.call(PROCESS_START_METHOD, {
        processId,
        argv: [options.shell],
        cwd: options.cwd,
        env: options.env,
        tty: true,
      });
    } catch (error) {
      this.processes.delete(processId);
      if (error instanceof RequestTimeoutError) {
        // Same late-start cancel as RemoteProcessService.spawn: keep the
        // server-side child from becoming an orphan without a handle.
        void this.connection.call(PROCESS_TERMINATE_METHOD, { processId }).catch(() => {});
      }
      throw toRemoteProcessError(error);
    }
    proc.resize(options.cols, options.rows);
    return proc;
  }
}
