import { afterEach, describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/index';

import {
  createCommandRunner,
  createTestAgent,
  execEnvServices,
  type TestAgentContext,
} from '../../harness';

describe('runShellCommand RPC', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('delegates to the shell command service', async () => {
    ctx = createTestAgent(execEnvServices({ processRunner: createCommandRunner('ok\n', 0) }));
    const context = ctx.get(IAgentContextMemoryService);

    const result = await ctx.rpc.runShellCommand({ command: 'echo ok' });

    expect(result.isError).toBe(false);
    expect(context.get().map(({ role, origin }) => ({ role, origin }))).toEqual([
      { role: 'user', origin: { kind: 'shell_command', phase: 'input' } },
      { role: 'user', origin: { kind: 'shell_command', phase: 'output' } },
    ]);
  });
});
