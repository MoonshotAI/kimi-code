import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath as nodeRealpath,
  rename as nodeRename,
  rm,
  stat as nodeStat,
  writeFile,
} from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';

import { BufferedReadable } from './execEnv/bufferedReadable';
import { decodeTextWithErrors, readUtf8Lines } from './execEnv/decodeText';
import {
  ProbeShellNotFoundError,
  probeHostEnvironmentFromNode,
  type HostEnvironmentInfo,
} from './execEnv/environmentProbe';
import { applyLoginShellPathFromNode } from './execEnv/loginShellPath';
import {
  OsProcessError,
  toHostFsError,
  type HostDirEntry,
  type HostFileStat,
  type OsEnvironmentPort,
  type OsFsPort,
  type OsHost,
  type OsProcess,
  type OsProcessPort,
  type OsProcessStdin,
  type OsSpawnOptions,
  type OsKind,
  type PathClass,
  type ShellName,
} from './types';

const isWindows: boolean = process.platform === 'win32';

function buildEnv(overrides: Record<string, string> | undefined): Record<string, string> | undefined {
  if (overrides === undefined) {
    return undefined;
  }
  return { ...(process.env as Record<string, string>), ...overrides };
}

function buildSpawnOptions(options: OsSpawnOptions): SpawnOptions {
  return {
    cwd: options.cwd,
    env: buildEnv(options.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: !isWindows,
    windowsHide: options.windowsHide ?? true,
  };
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      child.off('spawn', onSpawn);
      reject(err);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

class NodeOsProcess implements OsProcess {
  readonly stdin: OsProcessStdin;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly pid: number;

  private readonly _child: ChildProcess;
  private readonly _stdin: Writable;
  private readonly _stdout: BufferedReadable;
  private readonly _stderr: BufferedReadable;
  private _exitCode: number | null = null;
  private readonly _exitPromise: Promise<number>;
  private _disposed = false;

  constructor(child: ChildProcess, mergeStderr: boolean) {
    if (child.stdin === null || child.stdout === null) {
      throw new OsProcessError(
        'os.process.spawn_failed',
        'Process must be created with stdin/stdout pipes.',
      );
    }
    if (!mergeStderr && child.stderr === null) {
      throw new OsProcessError(
        'os.process.spawn_failed',
        'Process must be created with stderr pipe unless mergeStderr is set.',
      );
    }

    this._child = child;
    this._stdin = child.stdin;
    this._stdout = new BufferedReadable(child.stdout);
    this._stderr = mergeStderr ? this._stdout : new BufferedReadable(child.stderr as Readable);
    this.stdin = {
      write: (data: string | Uint8Array): void => {
        this._stdin.write(data);
      },
      end: (): void => {
        this._stdin.end();
      },
    };
    this.stdout = this._stdout;
    this.stderr = this._stderr;
    this.pid = child.pid ?? -1;

    this._exitPromise = new Promise<number>((resolve, reject) => {
      child.on('exit', (code: number | null) => {
        this._exitCode = code ?? -1;
        resolve(this._exitCode);
      });
      child.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  async wait(): Promise<number> {
    return this._exitPromise;
  }

  async kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    if (this.pid <= 0) {
      return;
    }

    if (isWindows) {
      const taskkillArgs = ['/T', '/F', '/PID', String(this.pid)];
      return new Promise<void>((resolve) => {
        const killer = spawn('taskkill', taskkillArgs, {
          stdio: 'ignore',
          windowsHide: true,
        });
        const done = (): void => {
          resolve();
        };
        killer.once('error', done);
        killer.once('close', done);
      });
    }

    try {
      process.kill(-this.pid, signal);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ESRCH') return;
      if (err.code === 'EPERM') {
        try {
          this._child.kill(signal);
        } catch {
        }
        return;
      }
      throw new OsProcessError(
        'os.process.kill_failed',
        `Failed to kill process ${this.pid}: ${err.message}`,
        {
          details: { pid: this.pid, signal, errno: err.code },
          cause: error,
        },
      );
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._stdin.destroy();
    this._stdout.destroy();
    if (this._stderr !== this._stdout) {
      this._stderr.destroy();
    }
  }
}

function createNodeProcessPort(): OsProcessPort {
  return {
    async spawn(command, args = [], options = {}) {
      const child = spawn(command, args as string[], buildSpawnOptions(options));
      try {
        await waitForSpawn(child);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        throw new OsProcessError(
          'os.process.spawn_failed',
          `Failed to spawn "${command}": ${err.message}`,
          {
            details: { command, args: [...args], cwd: options.cwd, errno: err.code },
            cause: error,
          },
        );
      }
      return new NodeOsProcess(child, options.mergeStderr ?? false);
    },
  };
}

const READ_CHUNK_SIZE = 64 * 1024;

function isUtf8Encoding(encoding: BufferEncoding): boolean {
  return encoding === 'utf-8' || encoding === 'utf8';
}

function* splitLinesKeepingTerminator(text: string): Generator<string> {
  if (text.length === 0) return;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.codePointAt(i) === 0x0a) {
      yield text.slice(start, i + 1);
      start = i + 1;
    }
  }
  if (start < text.length) {
    yield text.slice(start);
  }
}

function toHostFileStat(s: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtimeMs: number;
  ino: number;
}): HostFileStat {
  return {
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymbolicLink: s.isSymbolicLink(),
    size: s.size,
    mtimeMs: s.mtimeMs,
    ino: s.ino,
  };
}

export function createNodeFsPort(): OsFsPort {
  return {
    async readText(path, options) {
      try {
        if (options === undefined) {
          return await readFile(path, 'utf8');
        }
        const encoding = options.encoding ?? 'utf-8';
        const errors = options.errors ?? 'strict';
        return decodeTextWithErrors(await readFile(path), encoding, errors);
      } catch (error) {
        throw toHostFsError(error, { path, op: 'read' });
      }
    },

    async writeText(path, data) {
      try {
        await writeFile(path, data, 'utf8');
      } catch (error) {
        throw toHostFsError(error, { path, op: 'write' });
      }
    },

    async appendText(path, data) {
      try {
        await appendFile(path, data, 'utf8');
      } catch (error) {
        throw toHostFsError(error, { path, op: 'append' });
      }
    },

    async readBytes(path, n, offset = 0) {
      try {
        if (n === undefined && offset === 0) {
          const buf = await readFile(path);
          return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        }
        const fh = await open(path, 'r');
        try {
          const length = n ?? Math.max(0, (await fh.stat()).size - offset);
          const buf = Buffer.alloc(length);
          const { bytesRead } = await fh.read(buf, 0, length, offset);
          return buf.subarray(0, bytesRead);
        } finally {
          await fh.close();
        }
      } catch (error) {
        throw toHostFsError(error, { path, op: 'read' });
      }
    },

    async writeBytes(path, data) {
      try {
        await writeFile(path, data);
      } catch (error) {
        throw toHostFsError(error, { path, op: 'write' });
      }
    },

    async *readLines(path, options) {
      try {
        const encoding = options?.encoding ?? 'utf-8';
        const errors = options?.errors ?? 'strict';

        if (!isUtf8Encoding(encoding)) {
          const content = decodeTextWithErrors(await readFile(path), encoding, errors);
          yield* splitLinesKeepingTerminator(content);
          return;
        }

        yield* readUtf8Lines(createReadStream(path, { highWaterMark: READ_CHUNK_SIZE }), errors);
      } catch (error) {
        throw toHostFsError(error, { path, op: 'read' });
      }
    },

    async createExclusive(path, data) {
      try {
        const fh = await open(path, 'wx');
        try {
          await fh.writeFile(data);
          await fh.sync();
        } finally {
          await fh.close();
        }
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw toHostFsError(error, { path, op: 'create' });
      }
    },

    async stat(path) {
      try {
        return toHostFileStat(await nodeStat(path));
      } catch (error) {
        throw toHostFsError(error, { path, op: 'stat' });
      }
    },

    async lstat(path) {
      try {
        return toHostFileStat(await lstat(path));
      } catch (error) {
        throw toHostFsError(error, { path, op: 'lstat' });
      }
    },

    async readdir(path) {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map(
          (d): HostDirEntry => ({
            name: d.name,
            isFile: d.isFile(),
            isDirectory: d.isDirectory(),
            isSymbolicLink: d.isSymbolicLink(),
          }),
        );
      } catch (error) {
        throw toHostFsError(error, { path, op: 'readdir' });
      }
    },

    async mkdir(path, options) {
      try {
        await mkdir(path, { recursive: options?.recursive ?? false });
      } catch (error) {
        throw toHostFsError(error, { path, op: 'mkdir' });
      }
    },

    async remove(path) {
      try {
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        throw toHostFsError(error, { path, op: 'remove' });
      }
    },

    async rename(from, to) {
      try {
        await nodeRename(from, to);
      } catch (error) {
        throw toHostFsError(error, { path: from, op: 'rename' });
      }
    },

    async realpath(path) {
      try {
        return await nodeRealpath(path);
      } catch (error) {
        throw toHostFsError(error, { path, op: 'realpath' });
      }
    },
  };
}

function createNodeEnvironmentPort(): OsEnvironmentPort {
  let info: HostEnvironmentInfo | undefined;
  let probeError: Error | undefined;

  const translateError = (error: unknown): Error => {
    if (error instanceof ProbeShellNotFoundError) {
      return new OsProcessError('shell.git_bash_not_found', error.message, {
        details: { checkedPaths: error.checked },
        cause: error,
      });
    }
    return error instanceof Error ? error : new Error(String(error));
  };

  const readField = <K extends keyof HostEnvironmentInfo>(field: K): HostEnvironmentInfo[K] => {
    if (probeError !== undefined) {
      throw probeError;
    }
    if (info === undefined) {
      throw new Error(
        `OsEnvironmentPort.${field} accessed before ready — await environment.ready first.`,
      );
    }
    return info[field];
  };

  const ready: Promise<void> = Promise.all([
    probeHostEnvironmentFromNode().then((probed) => {
      info = probed;
    }),
    applyLoginShellPathFromNode(),
  ])
    .then(() => {})
    .catch((error: unknown) => {
      const translated = translateError(error);
      probeError = translated;
      throw translated;
    });
  ready.catch(() => {});

  return {
    ready,
    get osKind(): OsKind {
      return readField('osKind');
    },
    get osArch(): string {
      return readField('osArch');
    },
    get osVersion(): string {
      return readField('osVersion');
    },
    get shellName(): ShellName {
      return readField('shellName');
    },
    get shellPath(): string {
      return readField('shellPath');
    },
    get pathClass(): PathClass {
      return readField('pathClass');
    },
    get homeDir(): string {
      return readField('homeDir');
    },
  };
}

export function createNodeOsHost(): OsHost {
  return {
    process: createNodeProcessPort(),
    fs: createNodeFsPort(),
    environment: createNodeEnvironmentPort(),
  };
}
