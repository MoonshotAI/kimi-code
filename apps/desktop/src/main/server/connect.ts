import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { app } from 'electron';
import type { MainWindow } from '../window/main-window';
import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';
import { serverTokenPath } from '@moonshot-ai/kap-server';

import { startDesktopServer, type DesktopServerHandle } from './embedded-server';
import { desktopServerSecret, setEmbeddedServerOrigin } from './server-auth';
import { startShellEnvProbe } from '../system/shell-env';
import { setServerRegionSource } from './region';
import { rendererUrl, rendererDevBase } from '../app/protocol';
import { isLinuxNativeTitleBar, isOnboarded, isVibrancyEnabled } from '../app/ui-state';
import { resolveConnectTarget } from './connect-target';
import { dataUrl, errorHtml, updateTimeoutHtml, waitingHtml } from '../app/screens';
import { diagnosticRoots, log, logStartup, redactUrlForLog } from '../diagnostics/log';
import { trackDesktopEvent } from '../diagnostics/track';
import { restoreRemoteControlOnStartup } from './remote-control-restore';
import { IPC } from '../ipc/ipc-channels';
import type { StartupConnectResultEvent } from '../diagnostics/telemetry-events';

let serverHandle: DesktopServerHandle | null = null;
let serverInitialization: Promise<DesktopServerHandle | null> | null = null;
let serverCloseRequested = false;
let serverClosePromise: Promise<void> | null = null;

let consecutiveConnectFailures = 0;

type ConnectFailureStage = 'server_start' | 'load_url';

type ConnectFailurePhase = NonNullable<StartupConnectResultEvent['failure_phase']>;

let connectQueue: Promise<void> = Promise.resolve();

export function rendererDistRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'desktop-dist')
    : join(app.getAppPath(), 'desktop-dist');
}

const WEB_ASSETS_WAIT_INTERVAL_MS = 2_000;
const WEB_ASSETS_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

type WebAssetsWaitOutcome = 'appeared' | 'timeout' | 'aborted';

async function webAssetsReady(): Promise<boolean> {
  try {
    return (await stat(join(rendererDistRoot(), 'index.html'))).isFile();
  } catch {
    return false;
  }
}

async function waitForWebAssets(win: MainWindow): Promise<WebAssetsWaitOutcome> {
  if (await webAssetsReady()) return 'appeared';
  const startedAt = Date.now();
  log.warn('[kimi-desktop] web assets missing — waiting for the update installation to finish');
  logStartup('web-assets-wait');
  if (!win.isDestroyed()) {
    await win.loadURL(dataUrl(waitingHtml())).catch(() => {});
  }
  const finish = (outcome: WebAssetsWaitOutcome): WebAssetsWaitOutcome => {
    trackDesktopEvent('startup_web_assets_wait', { outcome, waited_ms: Date.now() - startedAt });
    return outcome;
  };
  while (Date.now() - startedAt < WEB_ASSETS_WAIT_TIMEOUT_MS) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, WEB_ASSETS_WAIT_INTERVAL_MS);
    });
    if (serverCloseRequested || win.isDestroyed()) return finish('aborted');
    if (await webAssetsReady()) {
      log.info('[kimi-desktop] web assets in place — continuing startup');
      return finish('appeared');
    }
  }
  return finish('timeout');
}

export function embeddedServerOrigin(): string | null {
  return serverHandle?.origin ?? null;
}

export function readServerToken(): string | undefined {
  try {
    const token = readFileSync(serverTokenPath(resolveKimiHome()), 'utf-8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export function closeServerHandle(): Promise<void> {
  serverCloseRequested = true;
  return (serverClosePromise ??= (async () => {
    try {
      await serverInitialization;
    } catch {}
    const handle = serverHandle;
    serverHandle = null;
    await handle?.close();
  })());
}

export function shutdownServerTelemetry(): Promise<void> | null {
  if (serverHandle !== null) return serverHandle.shutdownTelemetry();
  const initialization = serverInitialization;
  if (initialization === null) return null;
  return (async () => {
    const handle = await Promise.race([
      initialization,
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 2_000);
        timer.unref?.();
      }),
    ]);
    await handle?.shutdownTelemetry();
  })();
}

export function connect(win: MainWindow): Promise<void> {
  if (serverCloseRequested) return serverClosePromise ?? Promise.resolve();
  const run = connectQueue.then(() => connectOnce(win));
  connectQueue = run.catch(() => {});
  return run;
}

function isStartupPageAbort(error: unknown): boolean {
  return error instanceof Error && error.message.includes('(-3)') && error.message.includes("loading 'data:");
}

function isSameNavigationUrl(currentUrl: string, targetUrl: string): boolean {
  return currentUrl.split('#')[0] === targetUrl.split('#')[0];
}

async function loadRenderer(win: MainWindow, targetUrl: string): Promise<void> {
  let rendererFinished = false;
  const onDidFinishLoad = (): void => {
    if (isSameNavigationUrl(win.webContents.getURL(), targetUrl)) rendererFinished = true;
  };
  win.webContents.on('did-finish-load', onDidFinishLoad);
  try {
    await win.loadURL(targetUrl);
  } catch (error) {
    if (!rendererFinished || !isSameNavigationUrl(win.webContents.getURL(), targetUrl) || !isStartupPageAbort(error)) throw error;
    log.info('[kimi-desktop] renderer loaded after superseding the startup page');
  } finally {
    win.webContents.removeListener('did-finish-load', onDidFinishLoad);
  }
}

async function connectOnce(win: MainWindow): Promise<void> {
  if (serverCloseRequested) return;
  let failureStage: ConnectFailureStage = 'load_url';
  try {
    let origin: string;
    let token: string | undefined;
    const devBase = app.isPackaged ? undefined : rendererDevBase(process.env['KIMI_RENDERER_DEV_URL']);
    const shellEnvWaitStartedAt = Date.now();
    await startShellEnvProbe();
    logStartup('shell-env-ready', `waited=${Date.now() - shellEnvWaitStartedAt}ms`);
    const target = resolveConnectTarget(process.env['KIMI_SERVER_URL'], readServerToken);
    if (target.external) {
      ({ origin, token } = target);
      log.info(`[kimi-desktop] connected to external server ${redactUrlForLog(origin)}`);
    } else {
      let activeHandle = serverHandle;
      if (activeHandle === null) {
        failureStage = 'server_start';
        if (app.isPackaged) {
          const waitOutcome = await waitForWebAssets(win);
          if (serverCloseRequested) return;
          if (waitOutcome === 'aborted') return;
          if (waitOutcome === 'timeout') {
            consecutiveConnectFailures += 1;
            trackDesktopEvent('startup_connect_result', {
              ok: false,
              failure_phase: 'timeout',
              retry_count: consecutiveConnectFailures,
              error_class: 'WebAssetsWaitTimeout',
            });
            log.error('[kimi-desktop] timed out waiting for web assets');
            if (!win.isDestroyed()) {
              trackDesktopEvent('startup_failure_screen_shown', {});
              await win.loadURL(dataUrl(updateTimeoutHtml(diagnosticRoots()))).catch((error: unknown) => {
                log.error('[kimi-desktop] startup failure screen load failed', error);
              });
            }
            return;
          }
        }
        const initialization = (async (): Promise<DesktopServerHandle | null> => {
          if (serverCloseRequested) return null;
          const assetsReady = await webAssetsReady();
          if (devBase !== undefined && !assetsReady) {
            log.warn(
              '[kimi-desktop] dev mode: desktop-dist web assets not found; Remote Control links will 404. Run `pnpm --filter kimi-code-app run build:renderer` once to build them.',
            );
          }
          const serverStartedAt = Date.now();
          logStartup('server-start');
          const handle = await startDesktopServer({
            webAssetsDir:
              devBase === undefined || assetsReady ? rendererDistRoot() : undefined,
            extraCorsOrigins: devBase === undefined ? [] : [new URL(devBase).origin],
            debugEndpoints: !app.isPackaged,
          });
          logStartup('server-ready', `took=${Date.now() - serverStartedAt}ms`);
          serverHandle = handle;
          return handle;
        })();
        serverInitialization = initialization;
        try {
          const handle = await initialization;
          if (handle === null || serverCloseRequested) return;
          activeHandle = handle;
        } finally {
          if (serverInitialization === initialization) serverInitialization = null;
        }
        failureStage = 'load_url';
        log.info(`[kimi-desktop] connected to ${activeHandle.origin}`);
      } else {
        log.info(`[kimi-desktop] reusing embedded server ${activeHandle.origin}`);
      }
      ({ origin } = activeHandle);
      setEmbeddedServerOrigin(origin);
    }
    if (!win.isDestroyed()) {
      const serverToken = target.external ? token : desktopServerSecret();
      setServerRegionSource(origin, serverToken);
      void restoreRemoteControlOnStartup(origin, serverToken, fetch, () => {
        if (!win.isDestroyed()) win.webContents.send(IPC.remoteControlRestoreFinished);
      });
      const url = rendererUrl(origin, token, devBase, isOnboarded(), isVibrancyEnabled(), !target.external, isLinuxNativeTitleBar());
      const loadStartedAt = Date.now();
      logStartup('load-url', `url=${redactUrlForLog(url)}`);
      if (target.external) {
        await loadRenderer(win, url);
      } else {
        const startedAt = Date.now();
        try {
          await loadRenderer(win, url);
          trackDesktopEvent('embedded_renderer_load_result', {
            ok: true,
            duration_ms: Date.now() - startedAt,
          });
        } catch (error) {
          trackDesktopEvent('embedded_renderer_load_result', {
            ok: false,
            duration_ms: Date.now() - startedAt,
            error_class: error instanceof Error ? error.name : 'unknown',
          });
          throw error;
        }
      }
      logStartup('load-url-done', `took=${Date.now() - loadStartedAt}ms`);
      consecutiveConnectFailures = 0;
      trackDesktopEvent('startup_connect_result', { ok: true });
    }
  } catch (error) {
    consecutiveConnectFailures += 1;
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.replace(/'[^']*'|"[^"]*"|https?:\/\/\S+/g, ' ').toLowerCase();
    let failurePhase: ConnectFailurePhase = failureStage === 'server_start' ? 'spawn' : 'handshake';
    if (/401|unauthorized|token/.test(normalized)) failurePhase = 'auth';
    else if (/err_timed_out|timeout|etimedout/.test(normalized)) failurePhase = 'timeout';
    else if (failureStage === 'server_start' && /eaddrinuse|port/.test(normalized)) failurePhase = 'port';
    trackDesktopEvent('startup_connect_result', {
      ok: false,
      failure_phase: failurePhase,
      retry_count: consecutiveConnectFailures,
      error_class: error instanceof Error ? error.name : 'unknown',
    });
    log.error(`[kimi-desktop] connect failed (stage=${failureStage}): ${message}`);
    logStartup('connect-failed', `stage=${failureStage}`);
    if (!win.isDestroyed()) {
      trackDesktopEvent('startup_failure_screen_shown', {});
      await win.loadURL(dataUrl(errorHtml(message, diagnosticRoots()))).catch((error: unknown) => {
        log.error('[kimi-desktop] startup failure screen load failed', error);
      });
    }
  }
}
