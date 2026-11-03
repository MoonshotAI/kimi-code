import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { TOOLS_SECTION } from '#/agent/toolPolicy/configSection';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { AgentToolPolicyService } from '#/agent/toolPolicy/toolPolicyService';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ConfigTarget, IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';

import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../../app/bootstrap/stubs';
import { createTestAgent, type TestAgentContext } from '../../harness';

describe('AgentToolPolicyService', () => {
  let ctx: TestAgentContext;

  beforeEach(async () => {
    ctx = createTestAgent();
    await ctx.restorePersisted();
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('uses the known source for deny globs and infers it only when omitted', async () => {
    const policy = ctx.get(IAgentToolPolicyService);
    const config = ctx.get(IConfigService);
    const name = 'mcp__example__search';
    await config.replace(TOOLS_SECTION, { disabled: ['mcp__example__*'] }, ConfigTarget.Memory);
    expect(policy.isToolDenied(name)).toBe(true);
    expect(policy.isToolDenied(name, 'mcp')).toBe(true);
    expect(policy.isToolDenied(name, 'user')).toBe(false);
    expect(policy.isToolDenied(name, 'builtin')).toBe(false);

    await config.replace(TOOLS_SECTION, { disabled: [name] }, ConfigTarget.Memory);
    expect(policy.isToolDenied(name, 'user')).toBe(true);
  });

  it('follows changes to the global tools policy without re-reading the tools section per check', async () => {
    const policy = ctx.get(IAgentToolPolicyService);
    const config = ctx.get(IConfigService);
    const get = vi.spyOn(config, 'get');
    const toolsSectionReads = (): number =>
      get.mock.calls.filter(([domain]) => domain === TOOLS_SECTION).length;

    expect(policy.isToolActive('Bash')).toBe(true);
    expect(policy.isToolActiveForProfile({}, 'Bash')).toBe(true);
    expect(policy.isToolDenied('Bash')).toBe(false);
    expect(toolsSectionReads()).toBe(0);

    await config.replace(TOOLS_SECTION, { disabled: ['Bash'] }, ConfigTarget.Memory);
    get.mockClear();
    expect(policy.isToolActive('Bash')).toBe(false);
    expect(policy.isToolActiveForProfile({}, 'Bash')).toBe(false);
    expect(policy.isToolActive('Read')).toBe(true);
    expect(policy.isToolDenied('Bash')).toBe(true);
    expect(policy.isToolDenied('Read')).toBe(false);
    expect(toolsSectionReads()).toBe(0);

    await config.replace(TOOLS_SECTION, { enabled: ['Read'] }, ConfigTarget.Memory);
    get.mockClear();
    expect(policy.isToolActive('Read')).toBe(true);
    expect(policy.isToolActive('Bash')).toBe(false);
    expect(policy.isToolDenied('Bash')).toBe(false);
    expect(toolsSectionReads()).toBe(0);

    await config.replace(TOOLS_SECTION, null, ConfigTarget.Memory);
    get.mockClear();
    expect(policy.isToolActive('Bash')).toBe(true);
    expect(policy.isToolDenied('Bash')).toBe(false);
    expect(toolsSectionReads()).toBe(0);
  });

  it('fails closed when the initial config cannot be decoded', async () => {
    const disposables = new DisposableStore();
    try {
      const ix = disposables.add(new TestInstantiationService());
      const storage = new InMemoryStorageService();
      await storage.write(
        '',
        'config.toml',
        new TextEncoder().encode('[tools]\ndisabled = ["Bash"'),
      );
      ix.stub(ILogService, stubLog());
      ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', {}));
      ix.stub(IFileSystemStorageService, storage);
      ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
      ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
      ix.set(IConfigService, new SyncDescriptor(ConfigService));
      const config = ix.get(IConfigService);
      await config.ready;
      const policy = disposables.add(
        new AgentToolPolicyService(
          ctx.get(IAgentProfileService),
          config,
          ctx.get(ISessionToolPolicy),
          ctx.get(ISessionToolPolicyGate),
          ctx.get(IAgentToolExecutorService),
        ),
      );

      expect(() => policy.isToolActive('Bash')).toThrow(/could not be read/);
      expect(() => policy.isToolDenied('Bash')).toThrow(/could not be read/);
      expect(() => policy.isToolActiveForDisclosure('Bash')).toThrow(/could not be read/);
      expect(() => policy.isToolActiveForProfile({}, 'Bash')).toThrow(/could not be read/);
    } finally {
      disposables.dispose();
    }
  });
});
