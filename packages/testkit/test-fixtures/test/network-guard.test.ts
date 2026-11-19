import { request } from 'node:http';

import { expect, it } from 'vitest';

import { installNetworkGuard } from '#/fixtures/network';
import type { KapLaunchOptions, KapRunningServer } from '#/kap/harness';
import { kapFixtures, type KapFixtures } from '#/vitest/index';

function requestError(host = 'blocked.example.test'): Promise<Error> {
  return new Promise<Error>((resolve) => {
    request({
      host,
      port: 443,
      lookup: (_hostname, _options, callback) => callback(new Error('lookup disabled in this test'), '', 0),
    }).once('error', resolve).end();
  });
}

it('handles the connection error in the test body', async () => {
  await expect(requestError()).resolves.toBeInstanceOf(Error);
});

it('uninstalls a nested guard after inspecting the violation', async () => {
  const nested = installNetworkGuard();
  try {
    await expect(requestError()).resolves.toMatchObject({ code: 'ECONNREFUSED' });
    expect(nested.violations()).toEqual(['blocked.example.test:443']);
    expect(() => nested.assertNoViolations()).toThrow(/non-loopback address/);
  } finally {
    nested.uninstall();
  }
});

const fixtureTest = it.extend<{ label: string }>({
  label: async ({ task }, use) => {
    await requestError('setup.example.test');
    await use(task.name);
    await requestError('teardown.example.test');
  },
});

fixtureTest('uses a fixture that handles connection errors while starting and stopping', ({ label }) => {
  expect(label).toContain('uses a fixture');
});

const kapTest = it.extend<KapFixtures<KapRunningServer>>(kapFixtures({
  createServerLogger: ({ stream }) => stream,
  startServer: (options: KapLaunchOptions & { logger?: { write(line: string): void } }) => {
    options.logger?.write(JSON.stringify({ msg: 'network diagnostic server started' }));
    return Promise.resolve({ host: '127.0.0.1', port: 9, close: () => Promise.resolve() });
  },
}));

kapTest('reports KAP diagnostics for a network failure', async ({ kap }) => {
  expect(kap.server.host).toBe('127.0.0.1');
  await requestError();
});

it.each(['first', 'second'] as const)('removes the %s installation and retains the other host permissions', async (remove) => {
  const shared = 'shared.example.test';
  const guards = {
    first: installNetworkGuard({ allowHosts: ['first.example.test', shared, shared.toUpperCase()] }),
    second: installNetworkGuard({ allowHosts: ['second.example.test', shared.toUpperCase()] }),
  };
  const keep = remove === 'first' ? 'second' : 'first';
  const forwarded = { message: 'lookup disabled in this test' };
  try {
    for (const host of ['first.example.test', 'second.example.test', shared]) {
      await expect(requestError(host)).resolves.toMatchObject(forwarded);
    }
    guards[remove].uninstall();
    guards[remove].uninstall();
    await expect(requestError(`${remove}.example.test`)).resolves.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(requestError(`${keep}.example.test`)).resolves.toMatchObject(forwarded);
    await expect(requestError(shared)).resolves.toMatchObject(forwarded);
    guards[keep].uninstall();
    await expect(requestError(shared)).resolves.toMatchObject({ code: 'ECONNREFUSED' });
  } finally {
    guards.first.uninstall();
    guards.second.uninstall();
  }
});

it('starts the next test with no violations', () => {
  const nested = installNetworkGuard();
  try {
    expect(nested.violations()).toEqual([]);
  } finally {
    nested.uninstall();
  }
});
