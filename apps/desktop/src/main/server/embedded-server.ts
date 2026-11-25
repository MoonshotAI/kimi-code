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
import { configureWindowsBashRuntime } from './windows-bash-runtime';
import { createDesktopServerLogger } from './server-log';
import { createDesktopAuthTokenService } from './server-auth';
import { wireDesktopTelemetry } from '../diagnostics/telemetry';
import { startDesktopBrowserMcp } from '../browser/browser-mcp';
import { createDesktopBrowserAccess, registerDesktopBrowserMcp } from '../browser/browser-mcp-registration';
import { browserAgentControl, browserSubagentControl } from '../browser/browser-agent-control';
import { registerDesktopBrowserDialogReminder } from '../browser/browser-dialog-reminder';
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
  const bundledShell = configureWindowsBashRuntime();
  if (bundledShell !== undefined) log.info(`[kimi-desktop] Using bundled Windows Bash: ${bundledShell}`);
  configureSearchWorkerRuntime(fileURLToPath(new URL('./search-worker.cjs', import.meta.url)));
  installGlobalProxyDispatcher();
  const homeDir = resolveKimiHome();
  const host = resolveDesktopHostIdentity(homeDir);

  process.env['KIMI_CODE_REGION_MARKER'] = 'off';

  const browserAccess = createDesktopBrowserAccess(browserAgentControl, browserSubagentControl);
  const browserMcp = await startDesktopBrowserMcp({
    access: browserAccess,
    token:
      opts.debugEndpoints === true
        ? process.env['KIMI_BROWSER_MCP_TEST_TOKEN']
        : undefined,
  });
  log.info(`[kimi-desktop] Browser MCP listening on ${browserMcp.url}`);
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
    });
  } catch (error) {
    await browserMcp.close();
    throw error;
  }

  let browserRegistration: ReturnType<typeof registerDesktopBrowserMcp> | undefined;
  let dialogReminder: ReturnType<typeof registerDesktopBrowserDialogReminder> | undefined;
  let telemetry: Awaited<ReturnType<typeof wireDesktopTelemetry>>;
  const close = async (): Promise<void> => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => browserRegistration?.dispose()),
      Promise.resolve().then(() => dialogReminder?.dispose()),
      Promise.resolve().then(() => telemetry?.shutdown()),
      Promise.resolve().then(() => handle.close()),
      Promise.resolve().then(() => browserMcp.close()),
    ]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Server cleanup failed');
  };
  try {
    browserRegistration = registerDesktopBrowserMcp(handle.core, browserMcp.config, browserAccess);
    dialogReminder = registerDesktopBrowserDialogReminder(handle.core, { collect: collectBrowserDialogReminder, forgetSession: forgetSessionBrowserDialogs });
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
