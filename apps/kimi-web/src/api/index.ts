// apps/kimi-web/src/api/index.ts
// Singleton factory for the KimiWebApi daemon client.

import { readKimiApiConfig } from './config';
import type { KimiWebApi } from './types';
import { DaemonKimiWebApi } from './daemon/client';

let singleton: KimiWebApi | undefined;

export function getKimiWebApi(): KimiWebApi {
  singleton ??= new DaemonKimiWebApi(readKimiApiConfig());
  return singleton;
}
