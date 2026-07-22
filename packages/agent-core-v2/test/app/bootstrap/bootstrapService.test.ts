import { beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import {
  IBootstrapService,
  bootstrap,
  bootstrapSeed,
  resolveBootstrapOptions,
} from '#/app/bootstrap/bootstrap';
import { BootstrapService } from '#/app/bootstrap/bootstrapService';
import { IKosongConfigService } from '#/app/kosongConfig/kosongConfig';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

describe('BootstrapService (scoped)', () => {
  beforeEach(() => {
    // No `_clearScopedRegistryForTests()` here: the registry is process-wide,
    // and wiping it would break other suites sharing this worker.
    // Re-registering is enough — later registrations win in the scope
    // collection.
    registerScopedService(
      LifecycleScope.App,
      IBootstrapService,
      BootstrapService,
      InstantiationType.Eager,
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
    // `bootstrap()` eagerly instantiates the kosong persistence bridge; stub
    // it out so this test stays focused on the storage seed instead of
    // pulling the whole config/kosong graph into the module imports.
    const { app } = bootstrap({ homeDir: '/tmp/kimi-home' }, [
      [
        IKosongConfigService as ServiceIdentifier<unknown>,
        { _serviceBrand: undefined, ready: Promise.resolve() },
      ],
    ]);
    try {
      const storage = app.accessor.get(IFileSystemStorageService);
      expect(storage).toBeInstanceOf(FileStorageService);
    } finally {
      app.dispose();
    }
  });
});
