import { RequestError } from '@agentclientprotocol/sdk';

import { createNodeOsHost } from '#/features/os/index';
import type {
  OsFsPort,
  OsHost,
  OsProcess,
  OsProcessPort,
  OsSpawnOptions,
  TextDecodeErrors,
} from '#/features/os/index';

import type { AcpFsClient, AcpTerminalClient, AcpTerminalHandle } from './client';

export interface AcpOsConnection {
  readonly sessionId: string;
  readonly client: AcpFsClient & AcpTerminalClient;
  readonly fsReadTextFile: boolean;
  readonly fsWriteTextFile: boolean;
  readonly terminalEnabled: boolean;
}

export interface CreateAcpOsHostProps {
  readonly connection: AcpOsConnection;
  readonly local?: OsHost;
}

export interface AcpOsHostRouter {
  readonly host: OsHost;
  bind(connection: AcpOsConnection): void;
  unbind(sessionId: string): void;
}

export function createAcpOsHostRouter(props?: { local?: OsHost }): AcpOsHostRouter {
  const local = props?.local ?? createNodeOsHost();
  let active: { readonly sessionId: string; readonly host: OsHost } | undefined;
  const target = (): OsHost => active?.host ?? local;
  const host: OsHost = {
    process: {
      spawn: (command, args, options) => target().process.spawn(command, args, options),
    },
    fs: {
      readText: (path, options) => target().fs.readText(path, options),
      writeText: (path, data) => target().fs.writeText(path, data),
      appendText: (path, data) => target().fs.appendText(path, data),
      readBytes: (path, n, offset) => target().fs.readBytes(path, n, offset),
      writeBytes: (path, data) => target().fs.writeBytes(path, data),
      readLines: (path, options) => target().fs.readLines(path, options),
      createExclusive: (path, data) => target().fs.createExclusive(path, data),
      stat: (path) => target().fs.stat(path),
      lstat: (path) => target().fs.lstat(path),
      readdir: (path) => target().fs.readdir(path),
      mkdir: (path, options) => target().fs.mkdir(path, options),
      remove: (path) => target().fs.remove(path),
      rename: (from, to) => target().fs.rename(from, to),
      realpath: (path) => target().fs.realpath(path),
    },
    environment: local.environment,
  };
  return {
    host,
    bind: (connection) => {
      active = { sessionId: connection.sessionId, host: createAcpOsHost({ connection, local }) };
    },
    unbind: (sessionId) => {
      if (active?.sessionId === sessionId) active = undefined;
    },
  };
}

const OUTPUT_BYTE_LIMIT = 4 * 1024 * 1024;
const OUTPUT_POLL_MS = 250;

export function createAcpOsHost(props: CreateAcpOsHostProps): OsHost {
  const local = props.local ?? createNodeOsHost();
  const connection = props.connection;
  return {
    process: createAcpProcessPort(connection, local.process),
    fs: createAcpFsPort(connection, local.fs),
    environment: local.environment,
  };
}

function createAcpFsPort(
  connection: AcpOsConnection,
  inner: OsFsPort,
): OsFsPort {
  const readText = async (
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string> => {
    if (!connection.fsReadTextFile) {
      return inner.readText(path, options);
    }
    const { content } = await connection.client.readTextFile({
      sessionId: connection.sessionId,
      path,
    });
    return content;
  };
  const writeText = async (path: string, data: string): Promise<void> => {
    if (!connection.fsWriteTextFile) {
      return inner.writeText(path, data);
    }
    await connection.client.writeTextFile({
      sessionId: connection.sessionId,
      path,
      content: data,
    });
  };
  return {
    readText,
    writeText,
    appendText: async (path, data) => {
      if (!connection.fsReadTextFile || !connection.fsWriteTextFile) {
        return inner.appendText(path, data);
      }
      let existing = '';
      try {
        existing = await readText(path);
      } catch (error) {
        if (!isResourceNotFound(error)) throw error;
      }
      await writeText(path, existing + data);
    },
    readBytes: (path, n, offset) => inner.readBytes(path, n, offset),
    writeBytes: async (path, data) => {
      if (!connection.fsWriteTextFile) {
        return inner.writeBytes(path, data);
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        return inner.writeBytes(path, data);
      }
      await writeText(path, text);
    },
    readLines: async function* (path, options) {
      const text = await readText(path, options);
      yield* splitLinesKeepingTerminator(text);
    },
    createExclusive: (path, data) => inner.createExclusive(path, data),
    stat: (path) => inner.stat(path),
    lstat: (path) => inner.lstat(path),
    readdir: (path) => inner.readdir(path),
    mkdir: (path, options) => inner.mkdir(path, options),
    remove: (path) => inner.remove(path),
    rename: (from, to) => inner.rename(from, to),
    realpath: (path) => inner.realpath(path),
  };
}

function* splitLinesKeepingTerminator(text: string): Generator<string> {
  if (text.length === 0) return;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.codePointAt(i) === 0x0a) {
      yield text.slice(start, i + 1);
      start = i + 1;
    }
  }
  if (start < text.length) {
    yield text.slice(start);
  }
}

function isResourceNotFound(error: unknown): boolean {
  return error instanceof RequestError && error.code === -32002;
}

function isBashToolInvocation(args: readonly string[], options?: OsSpawnOptions): boolean {
  return (
    args.length === 2 &&
    args[0] === '-c' &&
    options?.env?.['NO_COLOR'] === '1' &&
    options?.env?.['TERM'] === 'dumb'
  );
}

function envRecordToAcp(
  env: Record<string, string> | undefined,
): Array<{ name: string; value: string }> | undefined {
  if (env === undefined) return undefined;
  return Object.entries(env).map(([name, value]) => ({ name, value }));
}

function createAcpProcessPort(
  connection: AcpOsConnection,
  local: OsProcessPort,
): OsProcessPort {
  return {
    spawn: async (command, args = [], options) => {
      if (!connection.terminalEnabled || !isBashToolInvocation(args, options)) {
        return local.spawn(command, args, options);
      }
      const handle = await connection.client.createTerminal({
        sessionId: connection.sessionId,
        command,
        args: [...args],
        env: envRecordToAcp(options?.env),
        cwd: options?.cwd ?? null,
        outputByteLimit: OUTPUT_BYTE_LIMIT,
      });
      return new AcpTerminalProcess(handle);
    },
  };
}

class AcpTerminalProcess implements OsProcess {
  readonly pid = 0;
  readonly external: { readonly kind: 'terminal'; readonly id: string };
  readonly stdin = {
    write: () => {},
    end: () => {},
  };

  private _exitCode: number | null = null;
  private emitted = 0;
  private readonly stdoutQueue = createChunkQueue();
  private readonly stderrQueue = createChunkQueue();
  private readonly pollTimer: ReturnType<typeof setInterval>;
  private readonly waitPromise: Promise<number>;
  private released = false;

  constructor(private readonly handle: AcpTerminalHandle) {
    this.external = { kind: 'terminal', id: handle.id };
    this.stderrQueue.close();
    const waitPromise = this.run();
    waitPromise.catch(() => {});
    this.waitPromise = waitPromise;
    this.pollTimer = setInterval(() => {
      void this.pump();
    }, OUTPUT_POLL_MS);
    this.pollTimer.unref?.();
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get stdout(): AsyncIterable<Uint8Array> {
    return this.stdoutQueue.iterable;
  }

  get stderr(): AsyncIterable<Uint8Array> {
    return this.stderrQueue.iterable;
  }

  wait(): Promise<number> {
    return this.waitPromise;
  }

  async kill(): Promise<void> {
    await this.handle.kill();
  }

  dispose(): void {
    if (this.released) return;
    this.released = true;
    this.stopPolling();
    void this.handle.release().catch(() => {});
  }

  private async run(): Promise<number> {
    const status = await this.handle.waitForExit();
    this._exitCode = status.exitCode ?? -1;
    await this.pump();
    this.stopPolling();
    this.stdoutQueue.close();
    return this._exitCode;
  }

  private async pump(): Promise<void> {
    try {
      const { output } = await this.handle.currentOutput();
      if (output.length > this.emitted) {
        this.stdoutQueue.push(new TextEncoder().encode(output.slice(this.emitted)));
        this.emitted = output.length;
      } else if (output.length < this.emitted) {
        this.emitted = output.length;
      }
    } catch {
    }
  }

  private stopPolling(): void {
    clearInterval(this.pollTimer);
  }
}

interface ChunkQueue {
  readonly iterable: AsyncIterable<Uint8Array>;
  push(chunk: Uint8Array): void;
  close(): void;
}

function createChunkQueue(): ChunkQueue {
  const chunks: Uint8Array[] = [];
  let closed = false;
  let notify: (() => void) | undefined;
  const wake = (): void => {
    const fn = notify;
    notify = undefined;
    fn?.();
  };
  return {
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Uint8Array>> => {
          for (;;) {
            const chunk = chunks.shift();
            if (chunk !== undefined) return { value: chunk, done: false };
            if (closed) return { value: undefined, done: true };
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
          }
        },
      }),
    },
    push: (chunk) => {
      chunks.push(chunk);
      wake();
    },
    close: () => {
      closed = true;
      wake();
    },
  };
}
