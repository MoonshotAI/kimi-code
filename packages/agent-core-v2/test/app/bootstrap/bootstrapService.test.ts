import { beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import { IBootstrapService, bootstrapSeed, resolveBootstrapOptions } from '#/app/bootstrap/bootstrap';
import { bootstrap } from '#/app/bootstrap/bootstrap';
import { BootstrapService } from '#/app/bootstrap/bootstrapService';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

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

  it('getEnv returns empty string for an explicitly empty value', () => {
    const host = createScopedTestHost(bootstrapSeed({ env: { EMPTY_VAR: '' } }));
    const svc = host.app.accessor.get(IBootstrapService);
    expect(svc.getEnv('EMPTY_VAR')).toBe('');
    host.dispose();
  });

  it('getEnv handles special characters in env values', () => {
    const host = createScopedTestHost(
      bootstrapSeed({ env: { PATH: '/usr/bin:/bin', SPECIAL: 'a=b&c<d>e|f' } }),
    );
    const svc = host.app.accessor.get(IBootstrapService);
    expect(svc.getEnv('PATH')).toBe('/usr/bin:/bin');
    expect(svc.getEnv('SPECIAL')).toBe('a=b&c<d>e|f');
    host.dispose();
  });
});

describe('resolveBootstrapOptions', () => {
  it('prefers explicit homeDir over KIMI_CODE_HOME over osHomeDir', () => {
    expect(resolveBootstrapOptions({ homeDir: '/a', osHomeDir: '/b', env: {} }).homeDir).toBe('/a');
    expect(resolveBootstrapOptions({ osHomeDir: '/b', env: { KIMI_CODE_HOME: '/c' } }).homeDir).toBe('/c');
    expect(resolveBootstrapOptions({ osHomeDir: '/b', env: {} }).homeDir).toBe('/b/.kimi-code');
  });

  it('uses explicit homeDir even when KIMI_CODE_HOME is also set', () => {
    expect(
      resolveBootstrapOptions({
        homeDir: '/explicit',
        osHomeDir: '/home/user',
        env: { KIMI_CODE_HOME: '/env/kimi' },
      }).homeDir,
    ).toBe('/explicit');
  });

  it('falls through to osHomeDir/.kimi-code when nothing is provided', () => {
    expect(resolveBootstrapOptions({ osHomeDir: '/home/user', env: {} }).homeDir).toBe(
      '/home/user/.kimi-code',
    );
  });

  it('handles empty osHomeDir gracefully', () => {
    expect(resolveBootstrapOptions({ osHomeDir: '', env: {} }).homeDir).toBe('/.kimi-code');
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

  it('passes the env bag through to the bootstrap context', () => {
    const { app, context } = bootstrap({
      homeDir: '/tmp/kimi-env',
      env: { MY_VAR: 'my-value' },
    });
    try {
      expect(context.env).toEqual({ MY_VAR: 'my-value' });
    } finally {
      app.dispose();
    }
  });

  it('rejects bootstrap with an empty homeDir', () => {
    expect(() => bootstrap({ homeDir: '' })).toThrow();
  });
});
