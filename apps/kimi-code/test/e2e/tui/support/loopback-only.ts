import { writeFileSync } from 'node:fs';

import { installNetworkGuard } from '@moonshot-ai/testkit/fixtures';

import { kimiCodeCdnBase } from '#/constant/app';
import { getFdAssetName } from '#/utils/process/fd-detect';

const guard = installNetworkGuard();
const report = process.env['KIMI_E2E_NETWORK_REPORT'];
if (report) process.once('exit', () => writeFileSync(report, JSON.stringify(guard.violations())));

const configBase = process.env['KIMI_CODE_BASE_URL'];
const fdArchive = `${kimiCodeCdnBase()}/fd/${getFdAssetName()}`;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const optionalConfig = url === `${configBase}/client_configs` || url === `${configBase}/resource_configs`;
  if ((method === 'GET' && url === fdArchive) || (method === 'POST' && optionalConfig)) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  return originalFetch(input, init);
};
