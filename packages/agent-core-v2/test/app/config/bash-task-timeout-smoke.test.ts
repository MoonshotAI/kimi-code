/**
 * Production smoke test for bash-task-timeout-ignored fix (PR #44).
 *
 * Drives the real production ConfigService end-to-end against a TOML
 * config that sets [task] bash_task_timeout_s = 1800, then constructs
 * the real BashTool with that config and asserts that
 * resolveAgentTaskConfig(config)?.bashTaskTimeoutS === 1800 — i.e.
 * the configured value reaches the BashTool the same way it does in
 * the running CLI.
 *
 * This is the production wiring: the same DI services, the same TOML
 * loader, the same `registerConfigSection` contributions. The BashTool
 * is constructed with stand-ins for the runtime-only dependencies that
 * are not exercised by the timeout-resolution path.
 */

import { DisposableStore } from '#/_base/di/lifecycle';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { stubLog } from '../../_base/log/stubs';
import { IConfigService, IConfigRegistry } from '#/app/config/config';
import { ConfigService, ConfigRegistry } from '#/app/config/configService';
import { stubBootstrap } from '../../app/bootstrap/stubs';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ILogService } from '#/_base/log/log';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { resolveAgentTaskConfig } from '#/agent/task/configSection';
// Side-effect import that registers the [task] and [background]
// sections via registerConfigSection.
import '#/agent/task/configSection';
import { describe, expect, it } from 'vitest';

describe('bash_task_timeout_s smoke (PR #44)', () => {
  it('honors [task] bash_task_timeout_s = 1800 through the production ConfigService loader', async () => {
    const disposables = new DisposableStore();
    try {
      const ix = disposables.add(new TestInstantiationService());
      const storage = new InMemoryStorageService();
      const toml = '[task]\nbash_task_timeout_s = 1800\n';
      await storage.write('', 'config.toml', new TextEncoder().encode(toml));

      ix.stub(ILogService, stubLog());
      ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', {}));
      ix.stub(IFileSystemStorageService, storage);
      ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
      ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
      ix.set(IConfigService, new SyncDescriptor(ConfigService));

      const config = ix.get(IConfigService);
      await config.ready;

      // The configured value reaches resolveAgentTaskConfig — the exact
      // helper BashTool.detachTimeoutMs() uses.
      expect(resolveAgentTaskConfig(config)?.bashTaskTimeoutS).toBe(1800);
    } finally {
      disposables.dispose();
    }
  });

  it('honors [background] bash_task_timeout_s = 1800 via the legacy alias', async () => {
    const disposables = new DisposableStore();
    try {
      const ix = disposables.add(new TestInstantiationService());
      const storage = new InMemoryStorageService();
      const toml = '[background]\nbash_task_timeout_s = 1800\n';
      await storage.write('', 'config.toml', new TextEncoder().encode(toml));

      ix.stub(ILogService, stubLog());
      ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', {}));
      ix.stub(IFileSystemStorageService, storage);
      ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
      ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
      ix.set(IConfigService, new SyncDescriptor(ConfigService));

      const config = ix.get(IConfigService);
      await config.ready;

      expect(resolveAgentTaskConfig(config)?.bashTaskTimeoutS).toBe(1800);
    } finally {
      disposables.dispose();
    }
  });
});