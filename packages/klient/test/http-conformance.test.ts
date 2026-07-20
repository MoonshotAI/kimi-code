/**
 * The http leg of the transport conformance suite — boots a real kap-server
 * in-process (port 0) and runs the shared `defineKlientConformance`
 * assertions over the http transport (events riding the lazy WS bridge).
 * The memory/ipc legs live in `memory.test.ts` / `ipc.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '@moonshot-ai/kap-server';

import { createKlient } from '../src/transports/http/index.js';
import { defineKlientConformance } from './helpers/conformance.js';

defineKlientConformance('http', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'klient-conformance-http-'));
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    homeDir,
    logLevel: 'silent',
  });
  const klient = createKlient({
    url: `http://127.0.0.1:${server.port}`,
    token: server.authTokenService.getToken(),
  });
  return {
    klient,
    cleanup: async () => {
      await klient.close();
      await server.close();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    },
  };
});
