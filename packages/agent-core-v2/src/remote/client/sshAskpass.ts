import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SSH_ASKPASS_PORT_ENV, SSH_ASKPASS_TOKEN_ENV } from '#/remote/askpass';

import { shQuote } from './launchers';

export interface SshAuthOptions {
  readonly password: string;
  readonly command: readonly [string, ...string[]];
}

export interface SshAskpass {
  readonly env: Record<string, string>;
  close(): Promise<void>;
}

export async function createSshAskpass(options: SshAuthOptions): Promise<SshAskpass> {
  const token = randomUUID();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
    socket.setEncoding('utf8');
    let input = '';
    socket.on('data', (chunk: string) => {
      input += chunk;
      if (input.length > 4096) {
        socket.destroy();
        return;
      }
      const end = input.indexOf('\n');
      if (end < 0) return;
      try {
        const request = JSON.parse(input.slice(0, end)) as { token?: unknown };
        if (request.token !== token) {
          socket.destroy();
          return;
        }
        socket.end(`${JSON.stringify({ value: options.password })}\n`);
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', () => {
    for (const socket of sockets) socket.destroy();
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('SSH askpass listener has no TCP address');
  }

  let directory: string | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(() => {});
  };

  try {
    let binary = options.command[0];
    if (options.command.length > 1 && process.platform !== 'win32') {
      directory = await mkdtemp(join(tmpdir(), 'kimi-ssh-askpass-'));
      binary = join(directory, 'askpass');
      await writeFile(binary, `#!/bin/sh\nexec ${options.command.map(shQuote).join(' ')} "$@"\n`, {
        mode: 0o700,
      });
    }
    return {
      env: {
        SSH_ASKPASS: binary,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: process.env['DISPLAY'] || 'kimi',
        [SSH_ASKPASS_PORT_ENV]: String(address.port),
        [SSH_ASKPASS_TOKEN_ENV]: token,
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
