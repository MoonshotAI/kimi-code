import { beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import { IBootstrapService, bootstrapSeed, resolveBootstrapOptions } from '#/app/bootstrap';
import { bootstrap } from '#/app/bootstrap/bootstrap';
import { BootstrapService } from '#/app/bootstrap/bootstrapService';
import {
  FileStorageService,
  IAppendLogStorage,
  IAtomicDocumentStorage,
  IBlobStorage,
  IStorageService,
} from '#/app/storage';

describe('BootstrapService (scoped)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
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
  it('routes each storage role token to its own FileStorageService instance', () => {
    const { app } = bootstrap({ homeDir: '/tmp/kimi-home' });
    try {
      const storage = app.accessor.get(IStorageService);
      const appendLog = app.accessor.get(IAppendLogStorage);
      const atomicDoc = app.accessor.get(IAtomicDocumentStorage);
      const blob = app.accessor.get(IBlobStorage);

      for (const instance of [storage, appendLog, atomicDoc, blob]) {
        expect(instance).toBeInstanceOf(FileStorageService);
      }

      // Roles are independently routable, so they must not collapse into one
      // shared backend instance by default.
      expect(new Set([storage, appendLog, atomicDoc, blob]).size).toBe(4);
    } finally {
      app.dispose();
    }
  });
});
