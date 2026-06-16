import { describe, expect, it } from 'vitest';

import { buildStatusReportLines } from '#/tui/components/messages/status-panel';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('status panel report lines', () => {
  it('formats runtime status, context, and managed usage without account or AGENTS.md rows', () => {
    const lines = buildStatusReportLines({
      version: '1.2.3',
      model: 'k2',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: 'Implement status',
      thinking: true,
      permissionMode: 'manual',
      planMode: false,
      swarmMode: false,
      contextUsage: 0.25,
      contextTokens: 2500,
      maxContextTokens: 10000,
      availableModels: {
        k2: {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 10000,
          displayName: 'Kimi K2',
        },
      },
      availableProviders: {
        'managed:kimi-code': {
          type: 'kimi',
          apiKey: 'sk-test',
        },
      },
      mcpServersSummary: '2 connected',
      goal: {
        goalId: 'goal-1',
        objective: 'Ship the status card',
        status: 'active',
        turnsUsed: 3,
        tokensUsed: 1200,
        wallClockMs: 45000,
        budget: {
          tokenBudget: null,
          turnBudget: null,
          wallClockBudgetMs: null,
          remainingTokens: null,
          remainingTurns: null,
          remainingWallClockMs: null,
          tokenBudgetReached: false,
          turnBudgetReached: false,
          wallClockBudgetReached: false,
          overBudget: false,
        },
      },
      status: {
        model: 'k2',
        thinkingLevel: 'high',
        permission: 'auto',
        planMode: true,
        contextTokens: 3000,
        maxContextTokens: 12000,
        contextUsage: 0.25,
      },
      managedUsage: {
        summary: null,
        limits: [
          {
            label: '5h limit',
            used: 8,
            limit: 100,
            resetHint: 'resets in 1h',
          },
        ],
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('>_ Kimi Code (v1.2.3)');
    expect(output).toContain('Model        Kimi K2 (thinking on)');
    expect(output).toContain('Directory    /tmp/project');
    expect(output).toContain('Permissions  auto');
    expect(output).toContain('Plan mode    on');
    expect(output).toContain('Swarm        off');
    expect(output).toContain('Session      ses-1');
    expect(output).toContain('Title        Implement status');
    expect(output).toContain('Goal         Ship the status card · active');
    expect(output).toContain('Providers    1');
    expect(output).toContain('Models       1');
    expect(output).toContain('MCP servers  2 connected');
    expect(output).toContain('Context window');
    expect(output).toContain('25.0%');
    expect(output).toContain('(3.0k / 12.0k)');
    expect(output).toContain('Plan usage');
    expect(output).toContain('8% used');
    expect(output).not.toContain('Account');
    expect(output).not.toContain('AGENTS.md');
  });

  it('falls back to app state and shows status load errors as warnings', () => {
    const lines = buildStatusReportLines({
      version: '1.2.3',
      model: '',
      workDir: '/tmp/project',
      sessionId: '',
      sessionTitle: null,
      thinking: false,
      permissionMode: 'manual',
      planMode: false,
      swarmMode: false,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
      availableProviders: {},
      statusError: 'No active session',
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('Model        not set');
    expect(output).toContain('Session      none');
    expect(output).toContain('Warning      No active session');
    expect(output).toContain('No context window data available.');
  });

  it('reads swarm mode from runtime status over stale app state', () => {
    const lines = buildStatusReportLines({
      version: '1.2.3',
      model: 'k2',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: null,
      thinking: false,
      permissionMode: 'manual',
      planMode: false,
      swarmMode: false,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
      availableProviders: {},
      status: { swarmMode: true },
    }).map(strip);

    expect(lines.join('\n')).toContain('Swarm        on');
  });
});
