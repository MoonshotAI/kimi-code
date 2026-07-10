import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  startServer,
  createServerLogger,
  IServerShutdownService,
  serverTokenPath,
  type RunningServer,
} from '@moonshot-ai/server';
import {
  installGlobalProxyDispatcher,
  resolveKimiHome,
  type KimiHostIdentity,
} from '@moonshot-ai/kimi-code-sdk';

export interface DesktopServerHandle {
  readonly origin: string;
  readonly port: number;
  readonly token: string | undefined;
  readonly close: () => Promise<void>;
}

export interface StartDesktopServerOptions {
  /** Directory that holds the built web UI (`apps/desktop/web-dist` in dev, `<resources>/web-dist` packaged). */
  readonly webAssetsDir: string;
  /** Host identity required upstream (Kimi-for-Coding rejects without it, 40340). */
  readonly identity: KimiHostIdentity;
  readonly logger?: ReturnType<typeof createServerLogger>;
}

const DESKTOP_LOCK_FILE = 'server-desktop.lock';

function desktopLockPath(): string {
  return join(resolveKimiHome(), DESKTOP_LOCK_FILE);
}

function toOrigin(address: string): string {
  return address.startsWith('http://') || address.startsWith('https://')
    ? address
    : `http://${address}`;
}

function parsePort(address: string): number {
  const idx = address.lastIndexOf(':');
  if (idx === -1) return 0;
  const n = Number(address.slice(idx + 1));
  return Number.isFinite(n) ? n : 0;
}

function readServerToken(): string | undefined {
  try {
    const token = readFileSync(serverTokenPath(resolveKimiHome()), 'utf-8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start an in-process Kimi server for the desktop host.
 *
 * - Loopback only, ephemeral port (`port: 0`), independent lock file so it never
 *   races the CLI daemon's `<home>/server/lock`.
 * - Neutralises the shutdown route's `process.exit` via `serviceOverrides` so a
 *   `/api/v1/shutdown` request cannot terminate the Electron main process.
 * - Returns once the HTTP server is listening (does not block the caller).
 */
export async function startDesktopServer(
  opts: StartDesktopServerOptions,
): Promise<DesktopServerHandle> {
  installGlobalProxyDispatcher();

  let handle: RunningServer | undefined;
  const shutdownOverride = {
    _serviceBrand: undefined,
    requestShutdown: async (_reason: string) => {
      if (handle !== undefined) {
        await handle.close();
      }
    },
  };

  handle = await startServer({
    host: '127.0.0.1',
    port: 0,
    logger: opts.logger,
    lockPath: desktopLockPath(),
    webAssetsDir: opts.webAssetsDir,
    coreProcessOptions: { identity: opts.identity },
    serviceOverrides: [[IServerShutdownService, shutdownOverride]],
  });

  return {
    origin: toOrigin(handle.address),
    port: parsePort(handle.address),
    token: readServerToken(),
    close: () => handle!.close(),
  };
}
