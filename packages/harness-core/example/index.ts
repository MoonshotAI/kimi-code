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
  const { harness, key, dataRoot, probe } = mountExample();
  const onSignal = (): void => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    void harness.close().then(() => process.exit(0));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  await probe.root.ready();
  process.stdout.write(`${key} ${probe.http()?.origin ?? ''} ${dataRoot}\n`);
}
