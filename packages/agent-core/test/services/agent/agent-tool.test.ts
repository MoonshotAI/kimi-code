import { describe, expect, it, vi } from 'vitest';

import type { SessionSubagentHost } from '../../../src/session/subagent-host';
import { executeTool } from '../../tools/fixtures/execute-tool';
import { testAgent } from './harness';

const signal = new AbortController().signal;

describe('Agent tool service runtime', () => {
  it('exposes Agent when a subagent host is available', () => {
    const subagentHost = createSubagentHost();

    const ctx = testAgent({ subagentHost });
    ctx.configure({ tools: ['Agent'] });

    expect(ctx.toolsData()).toContainEqual(
      expect.objectContaining({
        name: 'Agent',
        active: true,
        source: 'builtin',
      }),
    );
  });

  it('runs foreground Agent calls through the service runtime background manager', async () => {
    const subagentHost = createSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: Promise.resolve({ result: 'child summary' }),
      }),
    });
    const ctx = testAgent({ subagentHost });
    ctx.configure({ tools: ['Agent'] });

    const tool = ctx.tools.resolve('Agent');
    expect(tool).toBeDefined();
    await expect(
      executeTool(tool!, {
        turnId: '0',
        toolCallId: 'call_agent',
        args: {
          prompt: 'Investigate deeply',
          description: 'Investigate deeply',
          subagent_type: 'coder',
        },
        signal,
      }),
    ).resolves.toMatchObject({
      output: [
        'agent_id: agent-child',
        'actual_subagent_type: coder',
        'status: completed',
        '',
        '[summary]',
        'child summary',
      ].join('\n'),
    });
    expect(subagentHost.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'coder',
        parentToolCallId: 'call_agent',
        prompt: 'Investigate deeply',
        description: 'Investigate deeply',
        runInBackground: false,
      }),
    );
  });

  it('rejects Agent resume calls that also specify a subagent type', async () => {
    const subagentHost = createSubagentHost();
    const ctx = testAgent({ subagentHost });
    ctx.configure({ tools: ['Agent'] });

    const tool = ctx.tools.resolve('Agent');
    expect(tool).toBeDefined();
    await expect(
      executeTool(tool!, {
        turnId: '0',
        toolCallId: 'call_agent',
        args: {
          prompt: 'Continue',
          description: 'Continue work',
          resume: 'agent-child',
          subagent_type: 'coder',
        },
        signal,
      }),
    ).resolves.toMatchObject({
      isError: true,
      output: 'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.',
    });
    expect(subagentHost.resume).not.toHaveBeenCalled();
  });

  it('gates Agent background mode on task management tools', async () => {
    const subagentHost = createSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: Promise.resolve({ result: 'child summary' }),
      }),
    });
    const ctx = testAgent({ subagentHost });
    ctx.configure({ tools: ['Agent'] });

    const agentOnlyTool = ctx.tools.resolve('Agent');
    expect(agentOnlyTool).toBeDefined();
    await expect(
      executeTool(agentOnlyTool!, {
        turnId: '0',
        toolCallId: 'call_agent',
        args: {
          prompt: 'Investigate deeply',
          description: 'Investigate deeply',
          run_in_background: true,
        },
        signal,
      }),
    ).resolves.toMatchObject({
      isError: true,
      output:
        'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.',
    });

    await ctx.rpc.setActiveTools({ names: ['Agent', 'TaskList', 'TaskOutput', 'TaskStop'] });

    const managedTool = ctx.tools.resolve('Agent');
    expect(managedTool).toBeDefined();
    const result = await executeTool(managedTool!, {
      turnId: '0',
      toolCallId: 'call_agent',
      args: {
        prompt: 'Investigate deeply',
        description: 'Investigate deeply',
        run_in_background: true,
      },
      signal,
    });

    expect(result).toMatchObject({
      output: expect.stringContaining('status: running'),
    });
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain(
      'resume_hint: To continue or recover this same subagent later, call Agent(resume="agent-child", prompt="...").',
    );
    expect(subagentHost.spawn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profileName: 'coder',
        parentToolCallId: 'call_agent',
        prompt: 'Investigate deeply',
        description: 'Investigate deeply',
        runInBackground: true,
      }),
    );
  });
});

function createSubagentHost(
  overrides: Partial<SessionSubagentHost> = {},
): SessionSubagentHost {
  return {
    spawn: vi.fn(),
    resume: vi.fn(),
    markActiveChildDetached: vi.fn(),
    ...overrides,
  } as unknown as SessionSubagentHost;
}
