import { describe, expect, it } from 'vitest';

import { buildMcpStatusReportLines } from '#/tui/components/messages/mcp-status-panel';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

describe('buildMcpStatusReportLines', () => {
  it('folds a multi-line server error onto one row so the panel box stays intact', () => {
    const lines = buildMcpStatusReportLines({
      servers: [
        {
          name: 'ghidra',
          transport: 'stdio',
          status: 'failed',
          toolCount: 0,
          error:
            'MCP error -32000: Connection closed\nstderr: usage: bridge_mcp_ghidra.py [-h] [--mcp-host MCP_HOST]',
        },
      ],
    }).map(strip);

    // The box renderer (UsagePanelComponent.render) treats each returned string
    // as exactly one row, so an embedded newline would punch through the border.
    for (const line of lines) {
      expect(line).not.toContain('\n');
    }

    const errorLine = lines.find((line) => line.includes('error:'));
    expect(errorLine).toContain(
      'MCP error -32000: Connection closed stderr: usage: bridge_mcp_ghidra.py [-h] [--mcp-host MCP_HOST]',
    );
  });

  it('trims and keeps a single-line error intact', () => {
    const lines = buildMcpStatusReportLines({
      servers: [
        {
          name: 'ida',
          transport: 'http',
          status: 'failed',
          toolCount: 0,
          error: '  fetch failed  ',
        },
      ],
    }).map(strip);

    const errorLine = lines.find((line) => line.includes('error:'));
    expect(errorLine).toContain('error: fetch failed');
  });
});
