import { beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import {
  IBootstrapOptions,
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
    expect(resolveBootstrapOptions({ osHomeDir: '', env: {} }).homeDir).toBe('.kimi-code');
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

  it('passes the env bag through to the resolved BootstrapService', () => {
    const { app } = bootstrap({
      homeDir: '/tmp/kimi-env',
      env: { MY_VAR: 'my-value' },
    });
    try {
      expect(app.accessor.get(IBootstrapService).getEnv('MY_VAR')).toBe('my-value');
    } finally {
      app.dispose();
    }
  });

  it('passes an empty homeDir through as-is (empty string is not nullish)', () => {
    const { app } = bootstrap({ homeDir: '' });
    try {
      expect(app.accessor.get(IBootstrapService).homeDir).toBe('');
    } finally {
      app.dispose();
    }
  });
});

describe('bootstrapSeed', () => {
  it('returns a single seed entry keyed on the IBootstrapOptions identifier', () => {
    const seed = bootstrapSeed({ homeDir: '/tmp/kimi-seed' });
    expect(seed).toHaveLength(1);
    const [id, value] = seed[0]!;
    expect(id).toBe(IBootstrapOptions);
    expect(value).toEqual(
      resolveBootstrapOptions({ homeDir: '/tmp/kimi-seed' }),
    );
  });

  it('resolves the same value as resolveBootstrapOptions for the same input', () => {
    const input: Parameters<typeof bootstrapSeed>[0] = {
      homeDir: '/tmp/kimi-seed-eq',
      osHomeDir: '/home/user',
      env: { X: 'y' },
      clientVersion: '9.9.9',
    };
    const seed = bootstrapSeed(input);
    expect(seed[0]![1]).toEqual(resolveBootstrapOptions(input));
  });

  it('defaults clientVersion to "unknown" when input is empty', () => {
    const [, value] = bootstrapSeed({ osHomeDir: '/h', env: {} })[0]!;
    expect((value as ReturnType<typeof resolveBootstrapOptions>).clientVersion).toBe('unknown');
  });
});

describe('resolveBootstrapOptions — BootstrapInput field coverage', () => {
  it('falls back to process.platform when platform is omitted', () => {
    expect(resolveBootstrapOptions({ osHomeDir: '/h', env: {} }).platform).toBe(process.platform);
  });

  it('falls back to process.arch when arch is omitted', () => {
    expect(resolveBootstrapOptions({ osHomeDir: '/h', env: {} }).arch).toBe(process.arch);
  });

  it('falls back to process.cwd() when cwd is omitted', () => {
    expect(resolveBootstrapOptions({ osHomeDir: '/h', env: {} }).cwd).toBe(process.cwd());
  });

  it('preserves an explicit platform value', () => {
    expect(
      resolveBootstrapOptions({ osHomeDir: '/h', env: {}, platform: 'linux' }).platform,
    ).toBe('linux');
  });

  it('preserves an explicit arch value', () => {
    expect(
      resolveBootstrapOptions({ osHomeDir: '/h', env: {}, arch: 'arm64' }).arch,
    ).toBe('arm64');
  });

  it('preserves an explicit cwd value', () => {
    expect(
      resolveBootstrapOptions({ osHomeDir: '/h', env: {}, cwd: '/work' }).cwd,
    ).toBe('/work');
  });

  it('preserves an explicit clientVersion', () => {
    expect(
      resolveBootstrapOptions({ osHomeDir: '/h', env: {}, clientVersion: '1.2.3' }).clientVersion,
    ).toBe('1.2.3');
  });

  it('preserves an explicit configPath instead of joining homeDir/config.toml', () => {
    expect(
      resolveBootstrapOptions({
        homeDir: '/x',
        configPath: '/custom/config.toml',
        env: {},
      }).configPath,
    ).toBe('/custom/config.toml');
  });

  it('returns process.env by reference when env is omitted', () => {
    expect(resolveBootstrapOptions({ osHomeDir: '/h' }).env).toBe(process.env);
  });

  it('accepts a BootstrapInput with every field populated', () => {
    const full = resolveBootstrapOptions({
      homeDir: '/full',
      configPath: '/full/cfg.toml',
      env: { K: 'v' },
      osHomeDir: '/home/full',
      platform: 'darwin',
      arch: 'x64',
      cwd: '/full/cwd',
      clientVersion: 'full-version',
    });
    expect(full).toEqual({
      homeDir: '/full',
      configPath: '/full/cfg.toml',
      osHomeDir: '/home/full',
      platform: 'darwin',
      arch: 'x64',
      cwd: '/full/cwd',
      env: { K: 'v' },
      clientVersion: 'full-version',
    });
  });
});

describe('bootstrap() — BootstrapResult', () => {
  interface IExtraProbe {
    readonly _serviceBrand: undefined;
    readonly tag: 'extra-seed';
  }

  const IExtraProbe: ServiceIdentifier<IExtraProbe> =
    createDecorator<IExtraProbe>('bootstrap-extra-probe');

  it('returns a BootstrapResult exposing a usable app Scope', () => {
    const result = bootstrap({ homeDir: '/tmp/kimi-result' });
    expect(result).toHaveProperty('app');
    try {
      const storage = result.app.accessor.get(IFileSystemStorageService);
      expect(storage).toBeInstanceOf(FileStorageService);
    } finally {
      result.app.dispose();
    }
  });

  it('returned app provides accessor.get and dispose', () => {
    const { app } = bootstrap({ homeDir: '/tmp/kimi-result-shape' });
    try {
      expect(typeof app.accessor.get).toBe('function');
      expect(typeof app.dispose).toBe('function');
    } finally {
      app.dispose();
    }
  });

  it('app.dispose() releases the scope without throwing', () => {
    const { app } = bootstrap({ homeDir: '/tmp/kimi-result-dispose' });
    expect(() => app.dispose()).not.toThrow();
  });

  it('runs with no arguments and resolves a default homeDir', () => {
    const { app } = bootstrap();
    try {
      const svc = app.accessor.get(IBootstrapService);
      expect(typeof svc.homeDir).toBe('string');
      expect(svc.homeDir.length).toBeGreaterThan(0);
    } finally {
      app.dispose();
    }
  });

  it('honors extraSeeds alongside the default seeds', () => {
    const extra: IExtraProbe = { _serviceBrand: undefined, tag: 'extra-seed' };
    const { app } = bootstrap(
      { homeDir: '/tmp/kimi-extra' },
      [[IExtraProbe as ServiceIdentifier<unknown>, extra]],
    );
    try {
      expect(app.accessor.get(IExtraProbe).tag).toBe('extra-seed');
    } finally {
      app.dispose();
    }
  });

  it('still seeds the default services when extraSeeds is empty', () => {
    const { app } = bootstrap({ homeDir: '/tmp/kimi-empty-extra' }, []);
    try {
      expect(app.accessor.get(IFileSystemStorageService)).toBeInstanceOf(FileStorageService);
      expect(app.accessor.get(IBootstrapService).homeDir).toBe('/tmp/kimi-empty-extra');
    } finally {
      app.dispose();
    }
  });
});
