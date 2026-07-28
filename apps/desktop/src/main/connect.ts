import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';
import { serverTokenPath } from '@moonshot-ai/kap-server';

import { startDesktopServer, type DesktopServerHandle } from './server';
import { startShellEnvProbe } from './shell-env';
import { rendererUrl, rendererDevBase } from './protocol';
import { isOnboarded, isVibrancyEnabled } from './ui-state';
import { resolveConnectTarget } from './connect-target';
import { dataUrl, errorHtml } from './screens';
import { log, redactUrlForLog } from './log';
import { DESKTOP_PRODUCT_NAME } from '../shared/identity';

let serverHandle: DesktopServerHandle | null = null;

// connect() calls are serialized through this queue: window (re)creation
// (`activate` → createWindow) and the menu's 重试连接 can fire back-to-back,
// and two concurrent runs would both try to start the embedded server on an
// ephemeral port. Chaining guarantees only one start attempt exists at a
// time; later runs see the handle the first one established.
let connectQueue: Promise<void> = Promise.resolve();

export function rendererDistRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'desktop-dist')
    : join(app.getAppPath(), 'desktop-dist');
}

// Token for the external-server mode (KIMI_SERVER_URL): that server enforces
// the persistent bearer credential, so the renderer gets it via the URL
// fragment. The embedded server disables auth and needs no token. Read in the
// main process; the renderer never touches fs.
export function readServerToken(): string | undefined {
  try {
    const token = readFileSync(serverTokenPath(resolveKimiHome()), 'utf-8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export function serverLogPath(): string {
  return join(resolveKimiHome(), 'server', 'server.log');
}

export function closeServerHandle(): void {
  void serverHandle?.close();
  serverHandle = null;
}

// --- connect flow -------------------------------------------------------------

export function connect(win: BrowserWindow): Promise<void> {
  const run = connectQueue.then(() => connectOnce(win));
  // A rejected run must not poison the queue: the menu's 重试连接 is exactly
  // a later call, and it has to run even after a failed attempt.
  connectQueue = run.catch(() => {});
  return run;
}

async function connectOnce(win: BrowserWindow): Promise<void> {
  try {
    let origin: string;
    let token: string | undefined;
    // Renderer HMR (scripts/dev.mjs sets KIMI_RENDERER_DEV_URL): load the
    // renderer from the Vite dev server instead of the built desktop-dist, and
    // allow that origin through the embedded server's CORS allowlist. Packaged
    // builds always use `app://renderer`.
    const devBase = app.isPackaged ? undefined : rendererDevBase(process.env['KIMI_RENDERER_DEV_URL']);
    const target = resolveConnectTarget(process.env['KIMI_SERVER_URL'], readServerToken);
    if (target.external) {
      ({ origin, token } = target);
      // Redact: KIMI_SERVER_URL may carry basic-auth userinfo, which must not
      // persist to the log file (the origin itself keeps it — the connection
      // needs it).
      log.info(`[kimi-desktop] connected to external server ${redactUrlForLog(origin)}`);
    } else {
      // Reuse the live embedded server instead of restarting it. The server
      // runs in this very process, so a held handle means it is healthy;
      // closing it first would tear down perfectly good sessions on every
      // window (re)creation. A failed start leaves the handle null, so a
      // later retry comes back through here and starts fresh.
      if (serverHandle === null) {
        // The embedded server and every tool it spawns share this process's
        // env; wait for the probe (warmed up in index.ts) to fill it first.
        await startShellEnvProbe();
        serverHandle = await startDesktopServer({
          // No static fallback in HMR dev: the renderer comes from the Vite dev
          // server, and desktop-dist may not exist (kap-server would refuse to
          // start without index.html in it).
          webAssetsDir: devBase === undefined ? rendererDistRoot() : undefined,
          identity: { userAgentProduct: DESKTOP_PRODUCT_NAME, version: app.getVersion() },
          extraCorsOrigins: devBase === undefined ? [] : [new URL(devBase).origin],
        });
        log.info(`[kimi-desktop] connected to ${serverHandle.origin}`);
      } else {
        log.info(`[kimi-desktop] reusing embedded server ${serverHandle.origin}`);
      }
      ({ origin } = serverHandle);
    }
    if (!win.isDestroyed()) {
      await win.loadURL(rendererUrl(origin, token, devBase, isOnboarded(), isVibrancyEnabled()));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`[kimi-desktop] connect failed: ${message}`);
    if (!win.isDestroyed()) {
      await win.loadURL(dataUrl(errorHtml(message, serverLogPath())));
    }
  }
}
