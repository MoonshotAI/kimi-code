import { readFileSync } from 'node:fs';

import {
  startServer,
  createServerLogger,
  serverTokenPath,
} from '@moonshot-ai/kap-server';
import { bootstrapSeed, hostRequestHeadersSeed } from '@moonshot-ai/agent-core-v2';
import { createKimiDefaultHeaders, readKimiDeviceId } from '@moonshot-ai/kimi-code-oauth';
import {
  installGlobalProxyDispatcher,
  resolveKimiHome,
  type KimiHostIdentity,
} from '@moonshot-ai/kimi-code-sdk';

import {
  DESKTOP_DISPLAY_NAME,
  DESKTOP_MSH_PLATFORM,
  DESKTOP_REPLY_STYLE_GUIDE,
} from '../shared/identity';
import { log } from './log';
import { wireDesktopTelemetry } from './telemetry';

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
  readonly logger?: ReturnType<typeof createServerLogger>;
}

// The desktop host identifies itself to the upstream model API as its own
// platform. `createKimiDefaultHeaders` hardcodes X-Msh-Platform to the CLI's
// `kimi_code_cli`, so we override the header after building it (value lives
// in src/shared/identity.ts).
function desktopHostIdentity(
  homeDir: string,
  identity: KimiHostIdentity,
): { headers: Record<string, string>; deviceId: string; firstLaunch: boolean } {
  const firstLaunch = readKimiDeviceId(homeDir) === null;
  const headers = createKimiDefaultHeaders({ homeDir, ...identity });
  headers['X-Msh-Platform'] = DESKTOP_MSH_PLATFORM;
  const deviceId = headers['X-Msh-Device-Id'];
  if (deviceId === undefined || deviceId.length === 0) {
    throw new Error('Kimi identity did not provide a device id');
  }
  return { headers, deviceId, firstLaunch };
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
 * - Loopback only, ephemeral port (`port: 0`). kap-server no longer takes a
 *   single-instance lock — it registers under `<home>/server/instances/`, so
 *   the embedded server coexists with the CLI daemon and other desktops on
 *   the same KIMI_CODE_HOME.
 * - The v2 server never calls `process.exit` for `/api/v1/shutdown`; it just
 *   closes the embedded server, so the Electron main process is safe.
 * - Returns once the HTTP server is listening (does not block the caller).
 */
export async function startDesktopServer(
  opts: StartDesktopServerOptions,
): Promise<DesktopServerHandle> {
  installGlobalProxyDispatcher();
  const homeDir = resolveKimiHome();
  const deviceIdentity = desktopHostIdentity(homeDir, opts.identity);

  const handle = await startServer({
    host: '127.0.0.1',
    port: 0,
    logger: opts.logger,
    webAssetsDir: opts.webAssetsDir,
    // Report the kimi-code core version as `server_version` (GET /api/v1/meta).
    // kap-server's default reads the package.json next to its own module, which
    // in this bundled main process resolves to the desktop app's package.json —
    // pass it explicitly (injected by tsdown, see tsdown.config.ts).
    version: __KIMI_CORE_VERSION__,
    // System-prompt identity: fills the base template's ${product_name} /
    // ${reply_style_guide} slots — the CLI defaults describe a terminal.
    hostIdentity: {
      productName: DESKTOP_DISPLAY_NAME,
      replyStyleGuide: DESKTOP_REPLY_STYLE_GUIDE,
    },
    // Allow the local `app://renderer` origin so the renderer (served from
    // app://renderer) can call the loopback HTTP API. The v2 server takes the
    // origin allowlist directly (no KIMI_CODE_CORS_ORIGINS env needed).
    corsOrigins: ['app://renderer', ...(opts.extraCorsOrigins ?? [])],
    // Host identity is seeded as the full Kimi request headers (v2 dropped
    // `coreProcessOptions`); the upstream model API reads identity from these.
    seeds: [
      ...bootstrapSeed({ homeDir, clientVersion: opts.identity.version }),
      ...hostRequestHeadersSeed(deviceIdentity.headers),
    ],
  });

  // kap-server attaches no telemetry appender itself (everything falls into
  // the null appender); wire the cloud appender here, before the renderer can
  // create a session, and flush it before the server goes down.
  const telemetry = await wireDesktopTelemetry(handle.core, {
    deviceId: deviceIdentity.deviceId,
    firstLaunch: deviceIdentity.firstLaunch,
  });
  log.info(`[kimi-desktop] embedded server listening on http://${handle.host}:${handle.port}`);

  return {
    origin: `http://${handle.host}:${handle.port}`,
    port: handle.port,
    token: readServerToken(),
    close: async () => {
      await telemetry?.shutdown();
      await handle.close();
    },
  };
}
