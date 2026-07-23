/**
 * SudoAskpassManager — per-session secure sudo password channel.
 *
 * When the Bash tool spawns a command on macOS/Linux, the manager injects
 * `SUDO_ASKPASS` (plus a per-session token and the triggering command) into
 * the command's environment. Because the tool spawns with pipes and no TTY,
 * sudo invokes the askpass helper whenever it needs a password. The helper
 * connects to a per-session unix socket owned by this process; the manager
 * validates the token and issues a reverse-RPC `requestPassword` to the
 * connected client (the TUI's masked prompt), then replies over the socket.
 *
 * SECURITY: the password flows only TUI input → in-memory → socket → helper
 * stdout → sudo. It must never appear in logs, journals, tool results,
 * events, or telemetry. Nothing in this module logs request or reply
 * payloads.
 */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import type { Logger } from '#/logging/types';

import type { PasswordRequest, PasswordResult } from '../rpc/sdk-api';

/** Directory name inside the session state dir. */
const ASKPASS_DIR_NAME = 'sudo-askpass';
const SOCKET_NAME = 'askpass.sock';
const HELPER_SCRIPT_NAME = 'helper.sh';
const HELPER_IMPL_NAME = 'helper.mjs';
/** Cap on the command string forwarded to the UI with the password request. */
const MAX_COMMAND_LENGTH = 500;

/** Minimal surface the Bash tool needs for env injection. */
export interface SudoAskpassEnvProvider {
  /**
   * Env vars to merge into a spawned command's environment, or `undefined`
   * when the askpass channel is unavailable (disabled, unsupported platform,
   * no client handler, or socket setup failed).
   */
  envFor(command: string): Promise<Record<string, string> | undefined>;
}

export interface SudoAskpassManagerOptions {
  /** Session state directory; the askpass dir is created inside it. */
  readonly sessionDir: string;
  /** Master toggle (config `[sudo_askpass] enabled`); defaults to enabled by callers. */
  readonly enabled: boolean;
  /** Issues the password request to the connected client (reverse RPC). */
  readonly requestPassword?: (request: PasswordRequest) => Promise<PasswordResult>;
  readonly log?: Logger;
}

interface AskpassState {
  readonly dir: string;
  readonly token: string;
  readonly server: Server;
  readonly connections: Set<Socket>;
}

export function sudoAskpassDir(sessionDir: string): string {
  return join(sessionDir, ASKPASS_DIR_NAME);
}

export class SudoAskpassManager implements SudoAskpassEnvProvider {
  private state: AskpassState | undefined;
  private initPromise: Promise<AskpassState | undefined> | undefined;
  private disposed = false;

  constructor(private readonly options: SudoAskpassManagerOptions) {}

  private get supported(): boolean {
    return process.platform === 'darwin' || process.platform === 'linux';
  }

  async envFor(command: string): Promise<Record<string, string> | undefined> {
    if (!this.options.enabled || !this.supported || this.disposed) return undefined;
    if (this.options.requestPassword === undefined) return undefined;
    const state = await this.ensureInitialized();
    if (state === undefined) return undefined;
    return {
      SUDO_ASKPASS: join(state.dir, HELPER_SCRIPT_NAME),
      KIMI_SUDO_ASKPASS_TOKEN: state.token,
      KIMI_SUDO_ASKPASS_COMMAND:
        command.length > MAX_COMMAND_LENGTH ? command.slice(0, MAX_COMMAND_LENGTH) : command,
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const state = this.state ?? (await this.initPromise);
    this.initPromise = undefined;
    this.state = undefined;
    if (state === undefined) return;
    for (const connection of state.connections) {
      connection.destroy();
    }
    await new Promise<void>((resolve) => {
      state.server.close(() => {
        resolve();
      });
    });
    await rm(state.dir, { recursive: true, force: true });
  }

  private ensureInitialized(): Promise<AskpassState | undefined> {
    this.initPromise ??= this.initialize().catch((error: unknown) => {
      // Never reject spawns because the askpass channel failed — sudo will
      // simply fail with its normal "no askpass" error, same as when the
      // feature is off.
      this.options.log?.warn('sudo askpass setup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    });
    return this.initPromise;
  }

  private async initialize(): Promise<AskpassState | undefined> {
    if (this.disposed) return undefined;
    const dir = sudoAskpassDir(this.options.sessionDir);
    const token = randomBytes(16).toString('hex');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await writeFile(join(dir, HELPER_IMPL_NAME), renderHelperImpl(token), {
      mode: 0o600,
    });
    await writeFile(join(dir, HELPER_SCRIPT_NAME), renderHelperScript(dir), { mode: 0o700 });

    const socketPath = join(
      // The helper resolves its own dir via `import.meta.url`, which node
      // reports as the realpath — so the server must bind the realpath too,
      // or the helper dials a path the server never bound (and on macOS a
      // `/var` → `/private/var` realpath can even push it over the 104-byte
      // sun_path limit while the symlinked form fits).
      await realpath(dir),
      SOCKET_NAME,
    );
    // A resumed session may find a stale socket file from a crashed process.
    await rm(socketPath, { force: true });
    const connections = new Set<Socket>();
    const server = createServer((socket) => {
      connections.add(socket);
      socket.on('close', () => {
        connections.delete(socket);
      });
      this.handleConnection(socket, token);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        resolve();
      });
    });
    const state: AskpassState = { dir, token, server, connections };
    this.state = state;
    return state;
  }

  private handleConnection(socket: Socket, expectedToken: string): void {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      void this.serveRequest(socket, buffer.slice(0, newline), expectedToken);
    });
    socket.on('error', () => {
      socket.destroy();
    });
  }

  private async serveRequest(
    socket: Socket,
    line: string,
    expectedToken: string,
  ): Promise<void> {
    const reply = async (payload: Record<string, unknown>): Promise<void> => {
      await new Promise<void>((resolve) => {
        socket.end(`${JSON.stringify(payload)}\n`, () => {
          resolve();
        });
      });
    };

    let message: { token?: unknown; prompt?: unknown; command?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      await reply({ cancelled: true });
      return;
    }
    if (message.token !== expectedToken) {
      this.options.log?.warn('sudo askpass request with invalid token rejected');
      await reply({ cancelled: true });
      return;
    }

    let result: PasswordResult = { kind: 'cancelled' };
    const requestPassword = this.options.requestPassword;
    if (requestPassword !== undefined && !this.disposed) {
      try {
        result = await requestPassword({
          prompt: typeof message.prompt === 'string' ? message.prompt : '',
          command: typeof message.command === 'string' ? message.command : undefined,
        });
      } catch {
        result = { kind: 'cancelled' };
      }
    }
    await reply(result.kind === 'submitted' ? { password: result.password } : { cancelled: true });
  }
}

/** `helper.sh` — thin launcher sudo executes via `SUDO_ASKPASS`. */
function renderHelperScript(dir: string): string {
  return (
    '#!/bin/sh\n' +
    `exec "${shDoubleQuote(process.execPath)}" "${shDoubleQuote(join(dir, HELPER_IMPL_NAME))}" "$@"\n`
  );
}

/**
 * `helper.mjs` — plain dependency-free node script. Connects to the session
 * askpass socket, sends one JSON line with the token / sudo prompt / command,
 * and prints the replied password (plus newline) on stdout for sudo.
 * Exits 1 on cancellation or any channel failure so sudo fails normally.
 */
function renderHelperImpl(token: string): string {
  return `import { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const socketPath = join(dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(SOCKET_NAME)});
const payload =
  JSON.stringify({
    token: ${JSON.stringify(token)},
    prompt: process.argv.slice(2).join(' '),
    command: process.env.KIMI_SUDO_ASKPASS_COMMAND,
  }) + '\\n';

const socket = new Socket();
let buffer = '';
let done = false;
const finish = (code) => {
  if (done) return;
  done = true;
  process.exit(code);
};
socket.on('error', () => finish(1));
socket.connect(socketPath, () => {
  socket.write(payload);
});
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  const newline = buffer.indexOf('\\n');
  if (newline === -1 || done) return;
  let message;
  try {
    message = JSON.parse(buffer.slice(0, newline));
  } catch {
    finish(1);
    return;
  }
  if (message && typeof message.password === 'string') {
    done = true;
    process.stdout.write(message.password + '\\n', () => process.exit(0));
  } else {
    finish(1);
  }
});
socket.on('end', () => finish(1));
`;
}

/** Escape a path for embedding in a double-quoted POSIX shell string. */
function shDoubleQuote(path: string): string {
  return path.replaceAll(/["\\$`]/g, (ch) => `\\${ch}`);
}
