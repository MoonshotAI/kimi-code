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
  type PersistenceScopeName,
} from '#/app/bootstrap/bootstrap';

export function stubBootstrap(homeDir = '/tmp/kimi-home', env: NodeJS.ProcessEnv = {}): IBootstrapService {
  const sessionsScope = 'sessions';
  const scopes: Record<PersistenceScopeName, string> = {
    config: '',
    sessions: sessionsScope,
    blobs: 'blobs',
    store: 'store',
    logs: 'logs',
    cache: 'cache',
    credentials: 'credentials',
    cron: 'cron',
  };
  const sessionScope = (wsId: string, sId: string): string => `${sessionsScope}/${wsId}/${sId}`;
  const agentScope = (wsId: string, sId: string, aId: string): string =>
    `${sessionScope(wsId, sId)}/agents/${aId}`;
  return {
    _serviceBrand: undefined,
    platform: 'linux',
    arch: 'x64',
    cwd: '/tmp',
    osHomeDir: '/home/test',
    homeDir,
    configPath: `${homeDir}/config.toml`,
    configKey: 'config.toml',
    clientVersion: '0.0.0-test',
    sessionsDir: `${homeDir}/sessions`,
    blobsDir: `${homeDir}/blobs`,
    storeDir: `${homeDir}/store`,
    cacheDir: `${homeDir}/cache`,
    logsDir: `${homeDir}/logs`,
    getEnv: (name) => env[name],
    scope: (name) => scopes[name],
    sessionScope,
    agentScope,
    sessionDir: (wsId, sId) => `${homeDir}/${sessionScope(wsId, sId)}`,
    agentHomedir: (wsId, sId, aId) => `${homeDir}/${agentScope(wsId, sId, aId)}`,
  };
}

export function registerBootstrapServices(reg: ServiceRegistration): void {
  const homeDir = `/tmp/kimi-code-agent-core-v2-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  reg.defineInstance(IBootstrapService, stubBootstrap(homeDir));
}
