/**
 * `sudoAskpass` domain (L7) — `ISessionSudoAskpassService` implementation.
 *
 * Owns the per-session askpass IPC endpoint: a `<sessionDir>/sudo-askpass/`
 * directory (mode 0700) holding `helper.sh` (0700) and `helper.mjs` (0600),
 * the `askpass.sock` unix socket, and the random 128-bit token that
 * authenticates helper connections. The socket lives beside the helpers
 * when the path fits the platform `sun_path` cap (~104 bytes on macOS);
 * deep session dirs fall back to a short, session-keyed directory under the
 * OS temp dir, with the chosen path baked into the generated helper.mjs.
 * Everything starts lazily on the first `envForCommand` call and is torn
 * down when the Session scope is disposed; a dispose racing a start in
 * flight tears the half-built runtime down instead of leaking it.
 *
 * sudo (1.9+) only consults `SUDO_ASKPASS` in askpass mode, so the service
 * also resolves the real sudo from the ambient PATH and writes a
 * `bin/sudo` shim that prepends `-A`; `envForCommand` prepends that `bin`
 * dir to the spawned command's PATH. Without the shim, a no-TTY sudo would
 * fail with its terminal-required error instead of prompting.
 *
 * Each connection that presents a well-formed request with the session
 * token becomes ONE `password` interaction via `ISessionPasswordService`;
 * the reply carries either the password or `{cancelled: true}`. Concurrent
 * connections queue as independent interactions. A helper that disconnects
 * while its request is still pending resolves that request as cancelled so
 * it never lingers on the pending list. The password itself only flows
 * through the in-memory interaction resolution and the socket reply — it is
 * never logged, journaled, or broadcast (the interaction kernel journals a
 * redacted response for this kind).
 *
 * Bound at Session scope. Unix-only: `envForCommand` returns `undefined` on
 * Windows or when the `[sudo_askpass]` config section sets `enabled = false`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants, promises as fs } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { ISessionPasswordService } from '#/session/password/password';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { resolveSudoAskpassConfig } from './configSection';
import { helperMjsSource, helperShSource, sudoShimSource } from './helperAssets';
import {
  ISessionSudoAskpassService,
  SUDO_ASKPASS_COMMAND_ENV,
  SUDO_ASKPASS_ENV,
  SUDO_ASKPASS_TOKEN_ENV,
} from './sudoAskpass';

const ASKPASS_DIR_NAME = 'sudo-askpass';
const SOCKET_NAME = 'askpass.sock';
const MAX_SOCKET_PATH_CHARS = 100;
const COMMAND_ENV_MAX_CHARS = 500;
const MAX_REQUEST_LINE_CHARS = 64 * 1024;

interface AskpassRuntime {
  readonly dir: string;
  readonly socketDir: string;
  readonly token: string;
  readonly server: Server;
  readonly binDir?: string;
}

export class SessionSudoAskpassService extends Disposable implements ISessionSudoAskpassService {
  declare readonly _serviceBrand: undefined;

  private runtime: AskpassRuntime | undefined;
  private starting: Promise<AskpassRuntime> | undefined;
  private readonly connections = new Set<Socket>();

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IConfigService private readonly config: IConfigService,
    @ISessionPasswordService private readonly passwords: ISessionPasswordService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }

  async envForCommand(command: string): Promise<Record<string, string> | undefined> {
    if (this.env.osKind === 'Windows') return undefined;
    if (resolveSudoAskpassConfig(this.config)?.enabled === false) return undefined;
    let runtime: AskpassRuntime;
    try {
      runtime = await this.ensureStarted();
    } catch (error) {
      this.log.warn('sudo askpass channel failed to start; spawning without it', {
        err: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    const env: Record<string, string> = {
      [SUDO_ASKPASS_ENV]: join(runtime.dir, 'helper.sh'),
      [SUDO_ASKPASS_TOKEN_ENV]: runtime.token,
      [SUDO_ASKPASS_COMMAND_ENV]: command.slice(0, COMMAND_ENV_MAX_CHARS),
    };
    if (runtime.binDir !== undefined) {
      env['PATH'] = `${runtime.binDir}${delimiter}${process.env['PATH'] ?? ''}`;
    }
    return env;
  }

  private ensureStarted(): Promise<AskpassRuntime> {
    if (this.runtime !== undefined) return Promise.resolve(this.runtime);
    this.starting ??= this.start().then(
      (runtime) => {
        this.starting = undefined;
        if (this._store.isDisposed) {
          runtime.server.close();
          void fs.rm(runtime.dir, { recursive: true, force: true }).catch(() => {});
          if (runtime.socketDir !== runtime.dir) {
            void fs.rm(runtime.socketDir, { recursive: true, force: true }).catch(() => {});
          }
          throw new Error('sudo askpass service disposed during start');
        }
        this.runtime = runtime;
        return runtime;
      },
      (error: unknown) => {
        this.starting = undefined;
        throw error;
      },
    );
    return this.starting;
  }

  private async start(): Promise<AskpassRuntime> {
    const dir = join(this.ctx.sessionDir, ASKPASS_DIR_NAME);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);

    const { socketDir, socketPath } = resolveSocketLocation(dir);
    if (socketDir !== dir) {
      await fs.rm(socketDir, { recursive: true, force: true });
      await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
      await fs.chmod(socketDir, 0o700);
    }

    const helperMjs = join(dir, 'helper.mjs');
    const helperSh = join(dir, 'helper.sh');
    await fs.writeFile(helperMjs, helperMjsSource(socketPath), { mode: 0o600 });
    await fs.chmod(helperMjs, 0o600);
    await fs.writeFile(helperSh, helperShSource(dir, process.execPath), { mode: 0o700 });
    await fs.chmod(helperSh, 0o700);
    const binDir = await writeSudoShim(dir);

    const token = randomBytes(16).toString('hex');
    const server = createServer((socket) => {
      this.connections.add(socket);
      socket.once('close', () => this.connections.delete(socket));
      void this.handleConnection(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    return { dir, socketDir, token, server, binDir };
  }

  private async handleConnection(socket: Socket): Promise<void> {
    let request: { token?: unknown; prompt?: unknown; command?: unknown };
    try {
      request = JSON.parse(await readRequestLine(socket)) as typeof request;
    } catch {
      socket.destroy();
      return;
    }
    const runtime = this.runtime;
    if (
      runtime === undefined ||
      typeof request.token !== 'string' ||
      request.token !== runtime.token
    ) {
      socket.destroy();
      return;
    }
    const prompt = typeof request.prompt === 'string' ? request.prompt : '';
    const command = typeof request.command === 'string' ? request.command : undefined;

    const id = `sudo-askpass:${randomBytes(8).toString('hex')}`;
    let settled = false;
    const cancelOnClose = (): void => {
      if (!settled) this.passwords.resolve(id, { cancelled: true });
    };
    socket.once('close', cancelOnClose);
    const response = await this.passwords.request({ id, prompt, command });
    settled = true;
    socket.removeListener('close', cancelOnClose);
    if (socket.destroyed) return;
    const reply =
      response.cancelled || response.password === undefined
        ? { cancelled: true }
        : { password: response.password };
    socket.end(`${JSON.stringify(reply)}\n`);
  }

  override dispose(): void {
    const runtime = this.runtime;
    this.runtime = undefined;
    this.starting = undefined;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    runtime?.server.close();
    if (runtime !== undefined) {
      void fs.rm(runtime.dir, { recursive: true, force: true }).catch(() => {});
      if (runtime.socketDir !== runtime.dir) {
        void fs.rm(runtime.socketDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    super.dispose();
  }
}

async function writeSudoShim(dir: string): Promise<string | undefined> {
  const realSudo = resolveRealSudo();
  if (realSudo === undefined) return undefined;
  const binDir = join(dir, 'bin');
  const shim = join(binDir, 'sudo');
  await fs.mkdir(binDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(shim, sudoShimSource(realSudo), { mode: 0o700 });
  await fs.chmod(shim, 0o700);
  return binDir;
}

function resolveRealSudo(): string | undefined {
  for (const entry of (process.env['PATH'] ?? '').split(delimiter)) {
    if (entry === '') continue;
    const candidate = join(entry, 'sudo');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function resolveSocketLocation(dir: string): { socketDir: string; socketPath: string } {
  const inSession = join(dir, SOCKET_NAME);
  if (inSession.length <= MAX_SOCKET_PATH_CHARS) {
    return { socketDir: dir, socketPath: inSession };
  }
  const key = createHash('sha256').update(dir).digest('hex').slice(0, 16);
  const socketDir = join(tmpdir(), `kimi-sudo-askpass-${key}`);
  return { socketDir, socketPath: join(socketDir, SOCKET_NAME) };
}

function readRequestLine(socket: Socket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    const cleanup = (): void => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
    };
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        cleanup();
        resolve(buf.slice(0, idx));
        return;
      }
      if (buf.length > MAX_REQUEST_LINE_CHARS) {
        cleanup();
        reject(new Error('askpass request line too large'));
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error('askpass connection closed before a request line'));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
  });
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSudoAskpassService,
  SessionSudoAskpassService,
  InstantiationType.Delayed,
  'sudoAskpass',
);
