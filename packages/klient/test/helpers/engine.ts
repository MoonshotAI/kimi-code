import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrap, logSeed, resolveLoggingConfig } from '@moonshot-ai/agent-core-v2';

export const TEST_CLIENT_IDENTITY = {
  productName: 'klient-test',
  version: '0.0.0-test',
  platform: 'test',
} as const;

export interface TestEngine {
  readonly homeDir: string;
  readonly app: ReturnType<typeof bootstrap>['app'];
}

export async function makeEngine(prefix = 'klient-test-engine-'): Promise<TestEngine> {
  const homeDir = await mkdtemp(join(tmpdir(), prefix));
  const { app } = bootstrap({ homeDir, clientIdentity: TEST_CLIENT_IDENTITY }, [
    ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
  ]);
  return { homeDir, app };
}
