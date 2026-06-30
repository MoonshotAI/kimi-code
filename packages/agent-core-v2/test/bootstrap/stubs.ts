/**
 * `bootstrap` test stubs — shared `IBootstrapService` stub for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../bootstrap/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { IBootstrapService } from '#/bootstrap/bootstrapContract';

/**
 * An `IBootstrapService` rooted at the given home dir with the given env bag.
 * `detect()` rejects with "unused in test" so accidental calls surface loudly
 * rather than silently hitting the real OS probe.
 */
export function stubBootstrap(homeDir = '/tmp/kimi-home', env: NodeJS.ProcessEnv = {}): IBootstrapService {
  return {
    _serviceBrand: undefined,
    platform: 'linux',
    arch: 'x64',
    cwd: '/tmp',
    osHomeDir: '/home/test',
    homeDir,
    configPath: `${homeDir}/config.toml`,
    sessionsDir: `${homeDir}/sessions`,
    blobsDir: `${homeDir}/blobs`,
    storeDir: `${homeDir}/store`,
    cacheDir: `${homeDir}/cache`,
    logsDir: `${homeDir}/logs`,
    getEnv: (name) => env[name],
    detect: () => Promise.reject(new Error('unused in test')),
  };
}

/** Register the default `IBootstrapService` rooted at an isolated temp dir. */
export function registerBootstrapServices(reg: ServiceRegistration): void {
  const homeDir = `/tmp/kimi-code-agent-core-v2-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  reg.defineInstance(IBootstrapService, stubBootstrap(homeDir));
}
