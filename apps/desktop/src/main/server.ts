import {
  startServer,
  createServerLogger,
} from '@moonshot-ai/kap-server';
import {
  installGlobalProxyDispatcher,
  resolveKimiHome,
} from '@moonshot-ai/kimi-code-sdk';

import {
  DESKTOP_DISPLAY_NAME,
  DESKTOP_REPLY_STYLE_GUIDE,
} from '../shared/identity';
import { resolveDesktopHostIdentity } from './identity';
import { log } from './log';
import { wireDesktopTelemetry } from './telemetry';

export interface DesktopServerHandle {
  readonly origin: string;
  readonly port: number;
  readonly shutdownTelemetry: () => Promise<void>;
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
  /**
   * Extra CORS origins beyond `app://renderer` — e.g. the Vite dev server
   * origin (`http://127.0.0.1:<port>`) when running with renderer HMR.
   */
  readonly extraCorsOrigins?: readonly string[];
  /**
   * Mount kap-server's `/api/v1/debug` reflection RPC surface (every scoped
   * service callable). Dev-only affordance — pass `!app.isPackaged`: it lets
   * developers drive plugin/capability flows by hand (e.g. simulate a shelf
   * install to exercise the auto-complete hook) without a plugin UI.
   * Packaged builds must keep this off.
   */
  readonly debugEndpoints?: boolean;
  readonly logger?: ReturnType<typeof createServerLogger>;
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
  const host = resolveDesktopHostIdentity(homeDir);

  const handle = await startServer({
    host: '127.0.0.1',
    port: 0,
    logger: opts.logger,
    webAssetsDir: opts.webAssetsDir,
    // Report the kimi-code core version as `server_version` (GET /api/v1/meta).
    // kap-server's default reads the package.json next to its own module, which
    // in this bundled main process resolves to the desktop app's package.json —
    // pass it explicitly (injected by tsdown, see tsdown.config.ts). The host
    // product version travels in hostIdentity.version.
    serverVersion: __KIMI_CORE_VERSION__,
    // The desktop's host identity: kap-server derives the bootstrap client
    // identity and the outbound headers (User-Agent + X-Msh-*) from it, so the
    // OAuth device flow and the model / WebSearch requests all identify as the
    // desktop. displayName / replyStyleGuide fill the base system prompt slots
    // (the CLI defaults describe a terminal).
    hostIdentity: {
      ...host.identity,
      displayName: DESKTOP_DISPLAY_NAME,
      replyStyleGuide: DESKTOP_REPLY_STYLE_GUIDE,
    },
    // Allow the local `app://renderer` origin so the renderer (served from
    // app://renderer) can call the loopback HTTP API. The v2 server takes the
    // origin allowlist directly (no KIMI_CODE_CORS_ORIGINS env needed).
    corsOrigins: ['app://renderer', ...(opts.extraCorsOrigins ?? [])],
    // No bearer token on the embedded server; /api/v1/meta's
    // dangerous_bypass_auth keeps the renderer's ServerAuthDialog off.
    disableAuth: true,
    // Dev-only debug RPC surface (see StartDesktopServerOptions.debugEndpoints).
    debugEndpoints: opts.debugEndpoints === true,
  });

  // kap-server attaches no telemetry appender itself (everything falls into
  // the null appender); wire the cloud appender here, before the renderer can
  // create a session, and flush it before the server goes down.
  const telemetry = await wireDesktopTelemetry(handle.core, {
    deviceId: host.deviceId,
  });
  log.info(`[kimi-desktop] embedded server listening on http://${handle.host}:${handle.port}`);

  return {
    origin: `http://${handle.host}:${handle.port}`,
    port: handle.port,
    // Bounded flush on quit (telemetry.shutdown caps itself at 3s); exposed
    // separately because before-quit can await only this, never handle.close.
    shutdownTelemetry: () => telemetry?.shutdown() ?? Promise.resolve(),
    close: async () => {
      await telemetry?.shutdown();
      await handle.close();
    },
  };
}
