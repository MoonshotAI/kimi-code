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

// Simulates a transport drop: the executor dies on its own after serving for a
// while, ending the stdout stream underneath the client.
const exitAfterMs = Number(process.env['EXEC_SERVER_EXIT_AFTER_MS'] ?? '0');
if (exitAfterMs > 0) {
  setTimeout(() => {
    process.exit(0);
  }, exitAfterMs).unref();
}

// Simulates a half-open transport: after the delay the executor's event loop
// is blocked, so the pipe stays open but nothing is ever answered again.
const blockAfterMs = Number(process.env['EXEC_SERVER_BLOCK_AFTER_MS'] ?? '0');
if (blockAfterMs > 0) {
  const blockMs = Number(process.env['EXEC_SERVER_BLOCK_MS'] ?? '10000');
  setTimeout(() => {
    const until = Date.now() + blockMs;
    let spin = 0;
    while (Date.now() < until) spin += 1;
  }, blockAfterMs).unref();
}

const version = process.env['EXEC_SERVER_VERSION'] ?? '0.0.0-test';

try {
  process.exitCode = await runExecServer({ version });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`exec-server fixture failed: ${message}\n`);
  process.exitCode = 1;
}
