import { appendFileSync, writeFileSync } from 'node:fs';

import { FETCH_STUBS_ENV, installNetworkGuard, matchesFetchStub, NETWORK_LOG_ENV, type FetchStub } from '#/fixtures/network';

const log = process.env[NETWORK_LOG_ENV];
if (log === undefined || log === '') throw new Error(`The testkit network guard preload needs ${NETWORK_LOG_ENV}`);
writeFileSync(log, '', { flag: 'a' });
installNetworkGuard({ onViolation: (target) => appendFileSync(log, `${target}\n`) });

const stubs = JSON.parse(process.env[FETCH_STUBS_ENV] ?? '[]') as readonly FetchStub[];
if (stubs.length > 0) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const stub = stubs.find((candidate) => matchesFetchStub(candidate, method, url));
    return stub === undefined ? originalFetch(input, init) : Promise.resolve(new Response(null, { status: stub.status }));
  };
}
