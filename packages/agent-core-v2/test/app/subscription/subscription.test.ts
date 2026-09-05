import { describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IConfigRegistry } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../bootstrap/stubs';

import '#/app/subscription/configSection';
import {
  isSubscriptionMethodEnabled,
  SUBSCRIPTION_SECTION,
  type SubscriptionMethodId,
} from '#/app/subscription/subscription';

describe('subscription config section', () => {
  it('registers the subscription section and reads it via IConfigService', async () => {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-sub-cfg', {}));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await config.replace(SUBSCRIPTION_SECTION, { web_search: false });
    expect(config.get(SUBSCRIPTION_SECTION)).toEqual({ web_search: false });

    disposables.dispose();
  });

  it('is exposed on the package config surface as the subscription section', () => {
    expect(SUBSCRIPTION_SECTION).toBe('subscription');
  });
});

describe('isSubscriptionMethodEnabled', () => {
  function fakeConfig(value: Record<string, boolean> | undefined): IConfigService {
    return {
      _serviceBrand: undefined,
      get: ((domain: string) =>
        domain === SUBSCRIPTION_SECTION ? value : undefined) as IConfigService['get'],
    } as unknown as IConfigService;
  }

  const id = 'web_search' as SubscriptionMethodId;

  it('is enabled when the subscription section is absent', () => {
    expect(isSubscriptionMethodEnabled(fakeConfig(undefined), id)).toBe(true);
  });

  it('is enabled when the method is set to true', () => {
    expect(isSubscriptionMethodEnabled(fakeConfig({ web_search: true }), id)).toBe(true);
  });

  it('is disabled when the method is set to false', () => {
    expect(isSubscriptionMethodEnabled(fakeConfig({ web_search: false }), id)).toBe(false);
  });

  it('tolerates unknown method ids as enabled', () => {
    expect(isSubscriptionMethodEnabled(fakeConfig({ some_future_method: false }), id)).toBe(true);
  });
});
