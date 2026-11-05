import { serve } from '@hono/node-server';

import { createApp } from './app';
import { getLocalNetworkAddresses, hostForUrl, isAllInterfaces, resolveHost, resolveKimiCodeHome, resolvePort, resolveVisAuthToken } from './config';
import type { WebAsset } from './lib/web-asset';

export interface StartVisServerOptions {
  /** Sessions home. Defaults to env KIMI_CODE_HOME, else ~/.kimi-code. */
  readonly homeDir?: string;
  /** Port; 0 = auto-pick a free port. Defaults to env PORT, else 3001. */
  readonly port?: number;
  readonly host?: string;
  readonly authToken?: string;
  readonly webAsset?: WebAsset;
}

export interface StartedVisServer {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly lanUrls?: string[];
  readonly close: () => Promise<void>;
}

export async function startVisServer(
  opts: StartVisServerOptions = {},
): Promise<StartedVisServer> {
  const host = opts.host ?? resolveHost();
  const authToken = opts.authToken ?? resolveVisAuthToken(host);
  const homeDir = opts.homeDir ?? resolveKimiCodeHome();
  const app = await createApp({ authToken, homeDir, webAsset: opts.webAsset });
  const port = opts.port ?? resolvePort();

  return new Promise<StartedVisServer>((resolveStarted, rejectStarted) => {
    const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
      resolveStarted({
        port: info.port,
        host,
        url: `http://${hostForUrl(host)}:${info.port}/`,
        lanUrls: isAllInterfaces(host) ? getLocalNetworkAddresses(info.port) : undefined,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err?: Error) => (err ? fail(err) : done()));
          }),
      });
    });
    server.once('error', rejectStarted);
  });
}
