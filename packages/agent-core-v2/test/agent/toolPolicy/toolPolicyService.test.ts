import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOOLS_SECTION } from '#/agent/toolPolicy/configSection';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { AgentToolPolicyService } from '#/agent/toolPolicy/toolPolicyService';
import { ConfigTarget, IConfigService } from '#/app/config/config';

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
  it('keeps the last validated policy when an unvalidated fallback arrives', () => {
    let broken = false;
    let sectionHandler: ((event: unknown) => void) | undefined;
    const config = {
      assertValid: vi.fn(() => {
        if (broken) throw new Error('config could not be read');
      }),
      get: vi.fn(() => (broken ? undefined : { disabled: ['Bash'] })),
      onDidSectionChange: vi.fn((handler: (event: unknown) => void) => {
        sectionHandler = handler;
        return { dispose: () => { } };
      }),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: () => { } })),
    };
    const profile = { data: () => ({ activeToolNames: ['Bash'], disallowedTools: [] }) };
    const sessionToolPolicy = { disabledTools: () => [] };
    const toolPolicyGate = { disabledTools: [] };
    const toolExecutor = { registerToolCallGuard: vi.fn(() => ({ dispose: () => { } })) };
    const policy = new AgentToolPolicyService(
      profile as never,
      config as never,
      sessionToolPolicy as never,
      toolPolicyGate as never,
      toolExecutor as never,
    );

    broken = true;
    sectionHandler?.({
      domain: TOOLS_SECTION,
      source: 'set',
      value: { disabled: [] },
      previousValue: { disabled: ['Bash'] },
    });

    expect(policy.isToolDenied('Bash')).toBe(true);
  });

  it('refreshes the cached policy when an invalid section is removed', () => {
    let broken = false;
    let currentPolicy: { disabled: string[] } | undefined = { disabled: ['Bash'] };
    let configHandler: ((event: unknown) => void) | undefined;
    const config = {
      assertValid: vi.fn(() => {
        if (broken) throw new Error('config could not be read');
      }),
      get: vi.fn(() => currentPolicy),
      onDidSectionChange: vi.fn(() => ({ dispose: () => { } })),
      onDidChangeConfiguration: vi.fn((handler: (event: unknown) => void) => {
        configHandler = handler;
        return { dispose: () => { } };
      }),
    };
    const profile = { data: () => ({ activeToolNames: ['Bash'], disallowedTools: [] }) };
    const sessionToolPolicy = { disabledTools: () => [] };
    const toolPolicyGate = { disabledTools: [] };
    const toolExecutor = { registerToolCallGuard: vi.fn(() => ({ dispose: () => { } })) };
    const policy = new AgentToolPolicyService(
      profile as never,
      config as never,
      sessionToolPolicy as never,
      toolPolicyGate as never,
      toolExecutor as never,
    );

    broken = true;
    configHandler?.({
      domain: TOOLS_SECTION,
      source: 'reload',
      value: undefined,
      previousValue: { disabled: ['Bash'] },
    });
    broken = false;
    currentPolicy = undefined;
    configHandler?.({
      domain: TOOLS_SECTION,
      source: 'reload',
      value: undefined,
      previousValue: undefined,
    });

    expect(policy.isToolDenied('Bash')).toBe(false);
  });

  it('fails closed when the tools section cannot be validated', () => {
    const config = {
      assertValid: vi.fn(() => {
        throw new Error('config could not be read');
      }),
      get: vi.fn(),
      onDidSectionChange: vi.fn(() => ({ dispose: () => { } })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: () => { } })),
    };
    const profile = { data: () => ({ activeToolNames: [], disallowedTools: [] }) };
    const sessionToolPolicy = { disabledTools: () => [] };
    const toolPolicyGate = { disabledTools: [] };
    const toolExecutor = { registerToolCallGuard: vi.fn(() => ({ dispose: () => { } })) };

    expect(() => new AgentToolPolicyService(
      profile as never,
      config as never,
      sessionToolPolicy as never,
      toolPolicyGate as never,
      toolExecutor as never,
    )).toThrow('config could not be read');
  });

});
