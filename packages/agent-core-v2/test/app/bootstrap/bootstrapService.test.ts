import { beforeEach, describe, expect, it } from 'vitest';

import { LifecycleScope, ScopeActivation, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import {
  IBootstrapService,
  bootstrap,
  bootstrapSeed,
  resolveBootstrapOptions,
} from '#/app/bootstrap/bootstrap';
import { BootstrapService } from '#/app/bootstrap/bootstrapService';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

describe('BootstrapService (scoped)', () => {
  beforeEach(() => {
    // Keep the registry minimal so unrelated OnScopeCreated services do not run.
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IBootstrapService,
      BootstrapService,
      ScopeActivation.OnScopeCreated,
      'bootstrap',
    );
  });

  it('resolves homeDir/configPath from the seeded context token', () => {
    const host = createScopedTestHost(bootstrapSeed({ homeDir: '/tmp/kimi-home' }));
    const svc = host.app.accessor.get(IBootstrapService);
    expect(svc.homeDir).toBe('/tmp/kimi-home');
    expect(svc.configPath).toBe('/tmp/kimi-home/config.toml');
    expect(svc.sessionsDir).toBe('/tmp/kimi-home/sessions');
    host.dispose();
  });

  it('getEnv reads from the seeded env bag', () => {
    const host = createScopedTestHost(bootstrapSeed({ env: { FOO: 'bar' } }));
    const svc = host.app.accessor.get(IBootstrapService);
    expect(svc.getEnv('FOO')).toBe('bar');
    expect(svc.getEnv('MISSING')).toBeUndefined();
    host.dispose();
  });
});

describe('resolveBootstrapOptions', () => {
  it('prefers explicit homeDir over KIMI_CODE_HOME over osHomeDir', () => {
    expect(resolveBootstrapOptions({ homeDir: '/a', osHomeDir: '/b', env: {} }).homeDir).toBe('/a');
    expect(resolveBootstrapOptions({ osHomeDir: '/b', env: { KIMI_CODE_HOME: '/c' } }).homeDir).toBe('/c');
    expect(resolveBootstrapOptions({ osHomeDir: '/b', env: {} }).homeDir).toBe('/b/.kimi-code');
  });
});

describe('bootstrap() storage seeding', () => {
  it('seeds IFileSystemStorageService as a FileStorageService instance', () => {
    const { app } = bootstrap({ homeDir: '/tmp/kimi-home' });
    try {
      const storage = app.accessor.get(IFileSystemStorageService);
      expect(storage).toBeInstanceOf(FileStorageService);
    } finally {
      app.dispose();
    }
  });
});
