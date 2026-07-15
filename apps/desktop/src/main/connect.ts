import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';
import { serverTokenPath } from '@moonshot-ai/kap-server';

import { startDesktopServer, type DesktopServerHandle } from './server';
import { rendererUrl, rendererDevBase } from './protocol';
import { resolveConnectTarget } from './connect-target';
import { dataUrl, errorHtml } from './screens';
import { DESKTOP_PRODUCT_NAME } from '../shared/identity';

let serverHandle: DesktopServerHandle | null = null;

export function rendererDistRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'desktop-dist')
    : join(app.getAppPath(), 'desktop-dist');
}

// Token used by the renderer's `credentialStore.getToken()` (Task 4.5). Read in
// the main process from the server's token file; the renderer never touches fs.
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

export async function connect(win: BrowserWindow): Promise<void> {
  try {
    serverHandle?.close().catch(() => {});
    serverHandle = null;
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
      process.stdout.write(`[kimi-desktop] connected to external server ${origin}\n`);
    } else {
      serverHandle = await startDesktopServer({
        // No static fallback in HMR dev: the renderer comes from the Vite dev
        // server, and desktop-dist may not exist (kap-server would refuse to
        // start without index.html in it).
        webAssetsDir: devBase === undefined ? rendererDistRoot() : undefined,
        identity: { userAgentProduct: DESKTOP_PRODUCT_NAME, version: app.getVersion() },
        extraCorsOrigins: devBase === undefined ? [] : [new URL(devBase).origin],
      });
      ({ origin, token } = serverHandle);
      process.stdout.write(`[kimi-desktop] connected to ${origin}\n`);
    }
    if (!win.isDestroyed()) {
      await win.loadURL(rendererUrl(origin, token, devBase));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[kimi-desktop] startDesktopServer failed: ${message}\n`);
    if (!win.isDestroyed()) {
      await win.loadURL(dataUrl(errorHtml(message, serverLogPath())));
    }
  }
}
