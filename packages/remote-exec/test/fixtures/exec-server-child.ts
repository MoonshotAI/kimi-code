import { runExecServer } from '../../src/server/index';

const banner = process.env['EXEC_SERVER_BANNER'];
if (banner !== undefined && banner.length > 0) {
  process.stdout.write(banner);
}

const delayMs = Number(process.env['EXEC_SERVER_DELAY_MS'] ?? '0');
if (delayMs > 0) {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

const version = process.env['EXEC_SERVER_VERSION'] ?? '0.0.0-test';

try {
  process.exitCode = await runExecServer({ version });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`exec-server fixture failed: ${message}\n`);
  process.exitCode = 1;
}
