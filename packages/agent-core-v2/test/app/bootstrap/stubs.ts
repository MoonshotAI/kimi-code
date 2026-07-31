/**
 * `bootstrap` test stubs — shared `IBootstrapService` stub for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../bootstrap/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import {
  IBootstrapService,
  resolveHostArgs,
  type HostArgsInput,
  type PersistenceScopeName,
} from '#/app/bootstrap/bootstrap';

export const stubClientIdentity = {
  productName: 'test-product',
  version: '0.0.0-test',
  platform: 'test_platform',
} as const;

export function stubBootstrap(
  homeDir = '/tmp/kimi-home',
  env: NodeJS.ProcessEnv = {},
  args: HostArgsInput = {},
): IBootstrapService {
  const scopes: Record<PersistenceScopeName, string> = {
    config: '',
    sessions: 'sessions',
    blobs: 'blobs',
    store: 'store',
    logs: 'logs',
    cache: 'cache',
    credentials: 'credentials',
    cron: 'cron',
  };
  return {
    _serviceBrand: undefined,
    platform: 'linux',
    arch: 'x64',
    cwd: '/tmp',
    osHomeDir: '/home/test',
    homeDir,
    configPath: `${homeDir}/config.toml`,
    configKey: 'config.toml',
    clientIdentity: stubClientIdentity,
    args: resolveHostArgs(args),
    sessionsDir: `${homeDir}/sessions`,
    blobsDir: `${homeDir}/blobs`,
    storeDir: `${homeDir}/store`,
    cacheDir: `${homeDir}/cache`,
    logsDir: `${homeDir}/logs`,
    getEnv: (name) => env[name],
    scope: (name) => scopes[name],
  };
}

export function registerBootstrapServices(reg: ServiceRegistration): void {
  const homeDir = `/tmp/kimi-code-agent-core-v2-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  reg.defineInstance(IBootstrapService, stubBootstrap(homeDir));
}
