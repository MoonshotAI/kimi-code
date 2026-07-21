/**
 * Shared engine bootstrap for klient integration tests. Mirrors what
 * kap-server does: `bootstrap()` plus the `ILogOptions` seed the
 * Session-scoped log writer needs (bare `bootstrap({ homeDir })` leaves
 * `logOptions` unregistered and any eager service depending on `ILogService`
 * fails to instantiate).
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrap, logSeed, resolveLoggingConfig } from '@moonshot-ai/agent-core-v2';

export interface TestEngine {
  readonly homeDir: string;
  readonly app: ReturnType<typeof bootstrap>['app'];
}

export async function makeEngine(prefix = 'klient-test-engine-'): Promise<TestEngine> {
  const homeDir = await mkdtemp(join(tmpdir(), prefix));
  const { app } = bootstrap({ homeDir }, [
    ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
  ]);
  return { homeDir, app };
}
