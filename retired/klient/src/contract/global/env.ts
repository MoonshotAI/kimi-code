/**
 * `bootstrapService` — frozen startup snapshot: host facts and app path
 * layout. Mirrors `agent-core-v2/app/bootstrap/bootstrap.ts`. The string
 * properties are exposed as zero-arg reads.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

const stringRead = { input: z.tuple([]), output: z.string() };

export const envContract = {
  platform: stringRead,
  arch: stringRead,
  cwd: stringRead,
  osHomeDir: stringRead,
  homeDir: stringRead,
  configPath: stringRead,
  clientVersion: stringRead,
  sessionsDir: stringRead,
  blobsDir: stringRead,
  storeDir: stringRead,
  cacheDir: stringRead,
  logsDir: stringRead,
} satisfies ServiceContract;
