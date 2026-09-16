import type { Readable, Writable } from 'node:stream';

import { probeExecutorEnvironment } from './environment';
import { StdioHost, type StdioHostTuning } from './stdioHost';

export interface RunExecServerOptions {
  readonly version: string;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly errorOutput?: Writable;
  readonly capabilities?: Record<string, boolean>;
  readonly tuning?: StdioHostTuning;
}

// Light executor entry: composes only the node-local OS backends (fs, process,
// terminal, environment). No App scope, no config/OAuth/telemetry/session
// services. Logs go to stderr only; stdout carries protocol frames only.
export async function runExecServer(options: RunExecServerOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const log = (line: string): void => {
    errorOutput.write(`[kimi exec-server] ${line}\n`);
  };

  const environment = await probeExecutorEnvironment();
  const host = new StdioHost({
    version: options.version,
    environment,
    capabilities: options.capabilities,
    input,
    output,
    log,
    tuning: options.tuning,
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
