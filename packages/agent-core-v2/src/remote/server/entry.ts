import { probeExecutorEnvironment } from './environment';
import { StdioHost } from './stdioHost';

export interface RunExecServerOptions {
  readonly version: string;
}

export async function runExecServer(options: RunExecServerOptions): Promise<number> {
  const log = (line: string): void => {
    process.stderr.write(`[kimi exec-server] ${line}\n`);
  };

  const environment = await probeExecutorEnvironment();
  const host = new StdioHost({
    version: options.version,
    environment,
    input: process.stdin,
    output: process.stdout,
    log,
  });

  const onSignal = (signal: string): void => {
    void host.shutdown(`signal ${signal}`);
  };
  process.on('SIGHUP', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  host.start();
  await host.done;
  return 0;
}
