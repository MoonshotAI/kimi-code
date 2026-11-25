import { fileURLToPath } from 'node:url';
import { configureSearchWorkerRuntime } from '@moonshot-ai/kap-server/search-worker-runtime';
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
} from '../../shared/identity';
import { resolveDesktopHostIdentity } from '../app/identity';
import { log } from '../diagnostics/log';
import { createDesktopServerLogger } from './server-log';
import { createDesktopAuthTokenService } from './server-auth';
import { wireDesktopTelemetry } from '../diagnostics/telemetry';
import { HostBrowserFeature } from '../browser/browser-feature';
import { IHostBrowser } from '../browser/browser-host-contract';
import { createDesktopBrowserHost } from '../browser/browser-host';
import { startBrowserTestEndpoint, type BrowserTestEndpoint } from '../browser/browser-test-endpoint';
import { browserAgentControl, browserSubagentControl } from '../browser/browser-agent-control';
import { registerBrowserDialogCleanup } from '../browser/browser-dialog-reminder';
import { collectBrowserDialogReminder, forgetSessionBrowserDialogs } from '../browser/browser-automation';

export interface DesktopServerHandle {
  readonly origin: string;
  readonly port: number;
  readonly shutdownTelemetry: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface StartDesktopServerOptions {
  readonly webAssetsDir?: string;
  readonly extraCorsOrigins?: readonly string[];
  readonly debugEndpoints?: boolean;
  readonly logger?: ReturnType<typeof createServerLogger>;
}

export async function startDesktopServer(
  opts: StartDesktopServerOptions,
): Promise<DesktopServerHandle> {
  configureSearchWorkerRuntime(fileURLToPath(new URL('./search-worker.cjs', import.meta.url)));
  installGlobalProxyDispatcher();
  const homeDir = resolveKimiHome();
  const host = resolveDesktopHostIdentity(homeDir);

  process.env['KIMI_CODE_REGION_MARKER'] = 'off';

  const browserHost = createDesktopBrowserHost(browserAgentControl, browserSubagentControl, { collect: collectBrowserDialogReminder });
  const browserTestToken = opts.debugEndpoints === true ? process.env['KIMI_BROWSER_TEST_TOKEN'] : undefined;
  let browserTestEndpoint: BrowserTestEndpoint | undefined;
  let handle: Awaited<ReturnType<typeof startServer>>;
  try {
    handle = await startServer({
      host: '127.0.0.1',
      port: 0,
      logger: opts.logger ?? createDesktopServerLogger(),
      webAssetsDir: opts.webAssetsDir,
      env: { ...process.env },
      serverVersion: __KIMI_CORE_VERSION__,
      hostIdentity: {
        ...host.identity,
        displayName: DESKTOP_DISPLAY_NAME,
        replyStyleGuide: DESKTOP_REPLY_STYLE_GUIDE,
      },
      corsOrigins: ['app://renderer', ...(opts.extraCorsOrigins ?? [])],
      authTokenService: createDesktopAuthTokenService(homeDir),
      debugEndpoints: opts.debugEndpoints === true,
      seeds: [[IHostBrowser, browserHost]],
      features: [HostBrowserFeature],
    });
  } catch (error) {
    browserHost.dispose();
    throw error;
  }

  let dialogCleanup: ReturnType<typeof registerBrowserDialogCleanup> | undefined;
  let telemetry: Awaited<ReturnType<typeof wireDesktopTelemetry>>;
  const close = async (): Promise<void> => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => dialogCleanup?.dispose()),
      Promise.resolve().then(() => browserTestEndpoint?.close()),
      Promise.resolve().then(() => telemetry?.shutdown()),
      Promise.resolve().then(() => handle.close()),
      Promise.resolve().then(() => browserHost.dispose()),
    ]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Server cleanup failed');
  };
  try {
    dialogCleanup = registerBrowserDialogCleanup(handle.core, forgetSessionBrowserDialogs);
    if (browserTestToken !== undefined) {
      browserTestEndpoint = await startBrowserTestEndpoint(browserHost, browserTestToken);
      log.info(`[kimi-desktop] Browser test endpoint listening on ${browserTestEndpoint.url}`);
    }
    telemetry = await wireDesktopTelemetry(handle.core, { deviceId: host.deviceId });
    log.info(`[kimi-desktop] embedded server listening on http://${handle.host}:${handle.port}`);
    return {
      origin: `http://${handle.host}:${handle.port}`,
      port: handle.port,
      shutdownTelemetry: () => telemetry?.shutdown() ?? Promise.resolve(),
      close,
    };
  } catch (error) {
    await close().catch(cleanupError => log.error('[kimi-desktop] failed to clean up server initialization', cleanupError));
    throw error;
  }
}
