import { serve } from '@hono/node-server';

import { createApp } from './app';
import { KIMI_CODE_HOME, resolveHost, resolvePort, resolveVisAuthToken } from './config';
import { formatStartupBanner } from './startup-banner';

async function main(): Promise<void> {
  const host = resolveHost();
  const authToken = resolveVisAuthToken(host);
  const app = await createApp({ authToken, host, allowedHosts: process.env['VIS_ALLOWED_HOSTS'] });
  const port = resolvePort();
  serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    // Startup banner.
    process.stdout.write(
      formatStartupBanner({
        authToken,
        host,
        kimiCodeHome: KIMI_CODE_HOME,
        port: info.port,
      }),
    );
  });
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(
    `[vis-server] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
}
