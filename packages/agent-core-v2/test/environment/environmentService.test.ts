import { beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import {
  IEnvironmentService,
  environmentSeed,
} from '#/environment/environment';
import { EnvironmentService } from '#/environment/environmentService';

describe('EnvironmentService (scoped)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Core,
      IEnvironmentService,
      EnvironmentService,
      InstantiationType.Eager,
      'environment',
    );
  });

  it('resolves homeDir/configPath from the seeded context token', () => {
    const host = createScopedTestHost(environmentSeed('/tmp/kimi-home'));
    const env = host.core.accessor.get(IEnvironmentService);
    expect(env.homeDir).toBe('/tmp/kimi-home');
    expect(env.configPath).toBe('/tmp/kimi-home/config.toml');
    host.dispose();
  });

  it('detect() returns a cached OS/shell probe', async () => {
    const host = createScopedTestHost(environmentSeed('/tmp/kimi-home'));
    const env = host.core.accessor.get(IEnvironmentService);
    const a = await env.detect();
    const b = await env.detect();
    expect(a).toBe(b);
    expect(typeof a.osKind).toBe('string');
    expect(typeof a.shellPath).toBe('string');
    host.dispose();
  });
});
