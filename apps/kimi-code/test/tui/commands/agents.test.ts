import type { AgentBackgroundTaskInfo, BackgroundTaskInfo } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { UsagePanelComponent } from '#/tui/components/messages/usage-panel';
import { NO_ACTIVE_SESSION_MESSAGE } from '#/tui/constant/kimi-tui';
import { buildAgentStatusReportLines, handleAgentsCommand } from '#/tui/commands/agents';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function agentTask(overrides: Partial<AgentBackgroundTaskInfo>): AgentBackgroundTaskInfo {
  return {
    kind: 'agent',
    taskId: 'agent_task_1',
    description: 'Explore auth flow',
    status: 'running',
    detached: true,
    startedAt: 1000,
    endedAt: null,
    agentId: 'agent_123',
    subagentType: 'explore',
    ...overrides,
  };
}

function makeHost(tasks: readonly BackgroundTaskInfo[] | Error): SlashCommandHost {
  const session = {
    listBackgroundTasks: vi.fn(async () => {
      if (tasks instanceof Error) throw tasks;
      return tasks;
    }),
  };
  return {
    session,
    requireSession: () => session,
    showError: vi.fn(),
    state: {
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
  } as unknown as SlashCommandHost;
}

describe('buildAgentStatusReportLines', () => {
  it('shows an empty state when no subagents exist', () => {
    expect(buildAgentStatusReportLines([])).toEqual(['No background subagents.']);
  });

  it('formats agent tasks with status, type, id, and description', () => {
    expect(
      buildAgentStatusReportLines([
        agentTask({ taskId: 'agent_task_1', agentId: 'agent_a', subagentType: 'explore' }),
        agentTask({
          taskId: 'agent_task_2',
          agentId: 'agent_b',
          subagentType: 'coder',
          status: 'completed',
          endedAt: 2000,
          description: 'Implement fix',
        }),
      ]),
    ).toEqual([
      'running  explore  agent_a  Explore auth flow',
      'completed  coder  agent_b  Implement fix',
    ]);
  });

  it('adds an Agent resume hint for failed agents with ids', () => {
    expect(
      buildAgentStatusReportLines([
        agentTask({ status: 'failed', stopReason: 'Tool failed', agentId: 'agent_failed' }),
      ]),
    ).toEqual([
      'failed  explore  agent_failed  Explore auth flow',
      '  Resume: ask Kimi to call Agent(resume="agent_failed", prompt="...")',
      '  Reason: Tool failed',
    ]);
  });
});

describe('handleAgentsCommand', () => {
  it('renders only agent background tasks', async () => {
    const host = makeHost([
      agentTask({}),
      {
        kind: 'process',
        taskId: 'bash_1',
        description: 'pnpm test',
        status: 'running',
        detached: true,
        startedAt: 1000,
        endedAt: null,
        command: 'pnpm test',
        pid: 12345,
        exitCode: null,
      },
    ]);

    await handleAgentsCommand(host, 'status');

    expect(host.requireSession().listBackgroundTasks).toHaveBeenCalledWith({ activeOnly: false });
    expect(host.state.transcriptContainer.addChild).toHaveBeenCalledTimes(1);
    const component = vi.mocked(host.state.transcriptContainer.addChild).mock.calls[0]?.[0];
    expect(component).toBeInstanceOf(UsagePanelComponent);
    const rendered = component?.render(120).join('\n') ?? '';
    expect(rendered).toContain('agent_123');
    expect(rendered).toContain('Explore auth flow');
    expect(rendered).not.toContain('bash_1');
    expect(rendered).not.toContain('pnpm test');
    expect(host.state.ui.requestRender).toHaveBeenCalledTimes(1);
  });

  it('uses status as the default subcommand', async () => {
    const host = makeHost([agentTask({})]);

    await handleAgentsCommand(host, '');

    expect(host.requireSession().listBackgroundTasks).toHaveBeenCalledWith({ activeOnly: false });
    expect(host.state.transcriptContainer.addChild).toHaveBeenCalledTimes(1);
  });

  it('shows the inactive session error without loading tasks', async () => {
    const host = makeHost([]);
    host.session = undefined;

    await handleAgentsCommand(host, 'status');

    expect(host.showError).toHaveBeenCalledWith(NO_ACTIVE_SESSION_MESSAGE);
    expect(host.requireSession().listBackgroundTasks).not.toHaveBeenCalled();
  });

  it('rejects unsupported arguments', async () => {
    const host = makeHost([]);

    await handleAgentsCommand(host, 'cancel agent_123');

    expect(host.showError).toHaveBeenCalledWith('Usage: /agents [status]');
  });

  it('shows load errors', async () => {
    const host = makeHost(new Error('boom'));

    await handleAgentsCommand(host, '');

    expect(host.showError).toHaveBeenCalledWith('Failed to load subagents: boom');
  });
});
