import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOOLS_SECTION } from '#/agent/toolPolicy/configSection';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
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

  it('follows changes to the global tools policy without re-reading the tools section per check', async () => {
    const policy = ctx.get(IAgentToolPolicyService);
    const config = ctx.get(IConfigService);
    const get = vi.spyOn(config, 'get');
    const toolsSectionReads = (): number =>
      get.mock.calls.filter(([domain]) => domain === TOOLS_SECTION).length;

    expect(policy.isToolActive('Bash')).toBe(true);
    expect(policy.isToolActiveForProfile({}, 'Bash')).toBe(true);
    expect(toolsSectionReads()).toBe(0);

    await config.replace(TOOLS_SECTION, { disabled: ['Bash'] }, ConfigTarget.Memory);
    get.mockClear();
    expect(policy.isToolActive('Bash')).toBe(false);
    expect(policy.isToolActiveForProfile({}, 'Bash')).toBe(false);
    expect(policy.isToolActive('Read')).toBe(true);
    expect(toolsSectionReads()).toBe(0);

    await config.replace(TOOLS_SECTION, { enabled: ['Read'] }, ConfigTarget.Memory);
    get.mockClear();
    expect(policy.isToolActive('Read')).toBe(true);
    expect(policy.isToolActive('Bash')).toBe(false);
    expect(toolsSectionReads()).toBe(0);

    await config.replace(TOOLS_SECTION, null, ConfigTarget.Memory);
    get.mockClear();
    expect(policy.isToolActive('Bash')).toBe(true);
    expect(toolsSectionReads()).toBe(0);
  });
});
