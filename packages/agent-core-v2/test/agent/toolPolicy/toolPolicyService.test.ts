import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOOLS_SECTION } from '#/agent/toolPolicy/configSection';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { ConfigTarget, IConfigService } from '#/app/config/config';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';

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
    const sessionPolicy = ctx.get(ISessionToolPolicy);
    const name = 'mcp__example__search';
    await sessionPolicy.setDisabledTools(['mcp__example__*']);
    expect(policy.isToolDenied(name)).toBe(true);
    expect(policy.isToolDenied(name, 'mcp')).toBe(true);
    expect(policy.isToolDenied(name, 'user')).toBe(false);
    expect(policy.isToolDenied(name, 'builtin')).toBe(false);

    await sessionPolicy.setDisabledTools([name]);
    expect(policy.isToolDenied(name, 'user')).toBe(true);
  });

  it('captures the global tools policy when the session is initialized', async () => {
    await ctx.dispose();
    ctx = createTestAgent({
      initialConfig: { tools: { enabled: ['Read', 'Bash'], disabled: ['Bash'] } },
    });
    await ctx.restorePersisted();
    const policy = ctx.get(IAgentToolPolicyService);

    expect(policy.isToolActive('Read')).toBe(true);
    expect(policy.isToolActive('Bash')).toBe(false);
    expect(policy.isToolActive('Write')).toBe(false);
  });

  it('does not follow changes to the global tools policy or re-read it per check', async () => {
    const policy = ctx.get(IAgentToolPolicyService);
    const config = ctx.get(IConfigService);
    const get = vi.spyOn(config, 'get');
    const toolsSectionReads = (): number =>
      get.mock.calls.filter(([domain]) => domain === TOOLS_SECTION).length;
    const initialFingerprint = policy.getPolicyFingerprint();

    await config.replace(TOOLS_SECTION, { disabled: ['Bash'] }, ConfigTarget.Memory);
    expect(policy.isToolActive('Bash')).toBe(true);
    expect(policy.isToolActiveForProfile({}, 'Bash')).toBe(true);
    expect(policy.isToolDenied('Bash')).toBe(false);

    await config.replace(TOOLS_SECTION, { enabled: ['Read'] }, ConfigTarget.Memory);
    expect(policy.isToolActive('Read')).toBe(true);
    expect(policy.isToolActive('Bash')).toBe(true);
    expect(policy.isToolDenied('Bash')).toBe(false);
    expect(policy.getPolicyFingerprint()).toBe(initialFingerprint);

    await config.replace(TOOLS_SECTION, null, ConfigTarget.Memory);
    expect(policy.isToolActive('Bash')).toBe(true);
    expect(policy.isToolDenied('Bash')).toBe(false);
    expect(toolsSectionReads()).toBe(0);
  });
});
