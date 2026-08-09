/**
 * `bootstrapService` — frozen startup snapshot: host facts and app path
 * layout. Mirrors `agent-core-v2/app/bootstrap/bootstrap.ts`. The string
 * properties are exposed as zero-arg reads; `clientIdentity` returns the
 * host identity object (which replaced the flat `clientVersion` scalar).
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

const stringRead = { input: z.tuple([]), output: z.string() };

const clientIdentityRead = {
  input: z.tuple([]),
  output: z.object({
    productName: z.string(),
    version: z.string(),
    platform: z.string(),
    userAgentSuffix: z.string().optional(),
  }),
};

export const envContract = {
  platform: stringRead,
  arch: stringRead,
  cwd: stringRead,
  osHomeDir: stringRead,
  homeDir: stringRead,
  configPath: stringRead,
  clientVersion: stringRead,
  clientIdentity: clientIdentityRead,
  sessionsDir: stringRead,
  blobsDir: stringRead,
  storeDir: stringRead,
  cacheDir: stringRead,
  logsDir: stringRead,
} satisfies ServiceContract;
