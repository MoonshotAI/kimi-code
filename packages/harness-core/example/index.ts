import { HttpRef } from '@moonshot-ai/harness-core';

import { mountExample } from './app';
import { parseCliArgs, runCli } from './cli';

let args: ReturnType<typeof parseCliArgs>;
try {
  args = parseCliArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
if (args !== undefined) {
  try {
    await runCli(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  const { app, key, dataRoot } = mountExample();
  const onSignal = (): void => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    void app.disposeAsync().then(() => process.exit(0));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  await app.ready();
  process.stdout.write(`${key} ${app.node.resolve(HttpRef).origin ?? ''} ${dataRoot}\n`);
}
