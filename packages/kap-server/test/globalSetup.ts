import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IModelCatalog } from '@moonshot-ai/agent-core-v2';
import type { TestProject } from 'vitest/node';

import { startServer } from '../src/start';
import { fakeModelCatalog } from './helpers/fakeModelCatalog';
import { fixedTokenAuth } from './helpers/fixedAuth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

export const SHARED_SERVER_TOKEN = 'test-token';

export default async function globalSetup(project: TestProject): Promise<() => Promise<void>> {
  process.env['KIMI_CODE_EXPERIMENTAL_SEARCH_WORKER'] = 'false';
  process.env['KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL'] = 'false';
  const home = await mkdtemp(join(tmpdir(), 'kimi-kap-server-shared-home-'));
  const server = await startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir: home,
    logLevel: 'silent',
    authTokenService: fixedTokenAuth(SHARED_SERVER_TOKEN),
    seeds: [[IModelCatalog, fakeModelCatalog()]],
  });
  project.provide('sharedServer', {
    base: `http://127.0.0.1:${server.port}`,
    token: SHARED_SERVER_TOKEN,
  });
  return async () => {
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
}
