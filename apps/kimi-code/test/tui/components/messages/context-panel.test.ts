import { describe, expect, it } from 'vitest';

import { buildContextReportLines } from '#/tui/components/messages/context-panel';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

const BREAKDOWN = {
  contextTokens: 28300,
  maxContextTokens: 200000,
  systemPrompt: 2400,
  systemTools: 8000,
  mcpTools: 555,
  memoryFiles: 5100,
  skills: 2000,
  messages: 10200,
} as const;

describe('context panel report lines', () => {
  it('renders the model, window usage, and per-category token estimates', () => {
    const lines = buildContextReportLines({
      model: 'MiniMax-M2.7-highspeed',
      breakdown: BREAKDOWN,
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('Context Usage');
    expect(output).toContain('MiniMax-M2.7-highspeed');
    expect(output).toContain('27.6k/195k tokens (14.1%)');
    expect(output).toContain('Estimated usage by category');
    expect(output).toContain('System prompt: 2.3k tokens (1.2%)');
    expect(output).toContain('System tools: 7.8k tokens (4.0%)');
    expect(output).toContain('MCP tools: 555 tokens (0.3%)');
    expect(output).toContain('Memory files: 5k tokens (2.5%)');
    expect(output).toContain('Skills: 2k tokens (1.0%)');
    expect(output).toContain('Messages: 10k tokens (5.1%)');
    expect(output).toContain('Free space: 168k tokens (85.9%)');
  });

  it('lists MCP servers and skills when provided', () => {
    const lines = buildContextReportLines({
      model: 'k2',
      breakdown: BREAKDOWN,
      mcpServers: [
        { name: 'MiniMax', transport: 'stdio', status: 'connected', toolCount: 2 },
        { name: 'broken', transport: 'http', status: 'failed', toolCount: 0 },
      ],
      skills: [
        { name: 'code-review', description: '', path: '/p/code-review', source: 'user' },
        { name: 'tdd', description: '', path: '/p/tdd', source: 'project' },
      ],
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('MCP tools: 555 tokens (0.3%) · 2 tools');
    expect(output).toContain('MCP servers · /mcp');
    expect(output).toContain('MiniMax (2 tools)');
    expect(output).toContain('broken (0 tools)');
    expect(output).toContain('Skills · /skills');
    expect(output).toContain('code-review [user]');
    expect(output).toContain('tdd [project]');
  });

  it('omits percentages and free space when the context window is unknown', () => {
    const lines = buildContextReportLines({
      model: 'k2',
      breakdown: { ...BREAKDOWN, maxContextTokens: 0 },
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('27.6k tokens');
    expect(output).toContain('System prompt: 2.3k tokens');
    expect(output).not.toContain('(1.2%)');
    expect(output).toContain('Free space: unknown');
  });

  it('renders the error instead of the report when the breakdown fails', () => {
    const lines = buildContextReportLines({
      model: 'k2',
      error: 'session closed',
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('Context Usage');
    expect(output).toContain('session closed');
    expect(output).not.toContain('Estimated usage by category');
  });
});
