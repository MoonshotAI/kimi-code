import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  startServer,
  createServerLogger,
  serverTokenPath,
} from '@moonshot-ai/kap-server';
import { hostRequestHeadersSeed } from '@moonshot-ai/agent-core-v2';
import { createKimiDefaultHeaders } from '@moonshot-ai/kimi-code-oauth';
import {
  installGlobalProxyDispatcher,
  resolveKimiHome,
  type KimiHostIdentity,
} from '@moonshot-ai/kimi-code-sdk';

import { DESKTOP_MSH_PLATFORM } from '../shared/identity';

export interface DesktopServerHandle {
  readonly origin: string;
  readonly port: number;
  readonly token: string | undefined;
  readonly close: () => Promise<void>;
}

export interface StartDesktopServerOptions {
  /**
   * Directory that holds the built renderer assets
   * (`apps/desktop/desktop-dist` in dev, `<resources>/desktop-dist` packaged).
   * The server primarily serves the API; this is only the static-asset fallback,
   * and it points at the same `desktop-dist` the `app://renderer` protocol maps.
   * Omit when the renderer is served by the Vite dev server (renderer HMR dev)
   * — kap-server asserts the directory exists, and HMR dev never builds it.
   */
  readonly webAssetsDir?: string;
  /** Host identity required upstream (Kimi-for-Coding rejects without it, 40340). */
  readonly identity: KimiHostIdentity;
  /**
   * Extra CORS origins beyond `app://renderer` — e.g. the Vite dev server
   * origin (`http://127.0.0.1:<port>`) when running with renderer HMR.
   */
  readonly extraCorsOrigins?: readonly string[];
  /**
   * Local dev: lock under `server-desktop-dev.lock` instead so a running
   * packaged app (which holds `server-desktop.lock` on the same
   * KIMI_CODE_HOME) doesn't block `pnpm dev:desktop`, and vice versa.
   */
  readonly dev?: boolean;
  readonly logger?: ReturnType<typeof createServerLogger>;
}

const DESKTOP_LOCK_FILE = 'server-desktop.lock';
const DESKTOP_DEV_LOCK_FILE = 'server-desktop-dev.lock';

// The desktop host identifies itself to the upstream model API as its own
// platform. `createKimiDefaultHeaders` hardcodes X-Msh-Platform to the CLI's
// `kimi_code_cli`, so we override the header after building it (value lives
// in src/shared/identity.ts).
function desktopHostHeaders(identity: KimiHostIdentity): Record<string, string> {
  const headers = createKimiDefaultHeaders({ homeDir: resolveKimiHome(), ...identity });
  headers['X-Msh-Platform'] = DESKTOP_MSH_PLATFORM;
  return headers;
}

function desktopLockPath(dev: boolean): string {
  return join(resolveKimiHome(), dev ? DESKTOP_DEV_LOCK_FILE : DESKTOP_LOCK_FILE);
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
 * - The v2 server never calls `process.exit` for `/api/v1/shutdown`; it just
 *   closes the embedded server, so the Electron main process is safe.
 * - Returns once the HTTP server is listening (does not block the caller).
 */
export async function startDesktopServer(
  opts: StartDesktopServerOptions,
): Promise<DesktopServerHandle> {
  installGlobalProxyDispatcher();

  const handle = await startServer({
    host: '127.0.0.1',
    port: 0,
    logger: opts.logger,
    lockPath: desktopLockPath(opts.dev === true),
    webAssetsDir: opts.webAssetsDir,
    // Allow the local `app://renderer` origin so the renderer (served from
    // app://renderer) can call the loopback HTTP API. The v2 server takes the
    // origin allowlist directly (no KIMI_CODE_CORS_ORIGINS env needed).
    corsOrigins: ['app://renderer', ...(opts.extraCorsOrigins ?? [])],
    // Host identity is seeded as the full Kimi request headers (v2 dropped
    // `coreProcessOptions`); the upstream model API reads identity from these.
    seeds: hostRequestHeadersSeed(desktopHostHeaders(opts.identity)),
  });

  return {
    origin: `http://${handle.host}:${handle.port}`,
    port: handle.port,
    token: readServerToken(),
    close: () => handle.close(),
  };
}
