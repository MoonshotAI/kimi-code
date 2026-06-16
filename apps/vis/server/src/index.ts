import { KIMI_CODE_HOME, resolveHost, resolveVisAuthToken } from './config';
import { startVisServer } from './start';
import { formatStartupBanner } from './startup-banner';

async function main(): Promise<void> {
  const host = resolveHost();
  const authToken = resolveVisAuthToken(host);
  const { port } = await startVisServer({ host, authToken });
  process.stdout.write(
    formatStartupBanner({ authToken, host, kimiCodeHome: KIMI_CODE_HOME, port }),
  );
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(
    `[vis-server] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
}
