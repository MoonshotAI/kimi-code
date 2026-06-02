import type { McpServerInfo } from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

export interface McpStatusReportOptions {
  readonly colors: ColorPalette;
  readonly servers: readonly McpServerInfo[];
}

const STATUS_PRIORITY: Record<McpServerInfo['status'], number> = {
  failed: 0,
  'needs-auth': 1,
  pending: 2,
  connected: 3,
  disabled: 4,
};

const STATUS_LABEL: Record<McpServerInfo['status'], string> = {
  connected: 'connected',
  pending: 'pending',
  'needs-auth': 'needs auth',
  failed: 'failed',
  disabled: 'disabled',
};

const SUMMARY_ORDER: readonly McpServerInfo['status'][] = [
  'connected',
  'pending',
  'needs-auth',
  'failed',
  'disabled',
];

function statusPainter(
  status: McpServerInfo['status'],
  colors: ColorPalette,
): (text: string) => string {
  switch (status) {
    case 'connected':
      return chalk.hex(colors.success);
    case 'failed':
      return chalk.hex(colors.error);
    case 'needs-auth':
    case 'pending':
      return chalk.hex(colors.warning);
    case 'disabled':
      return chalk.hex(colors.textDim);
  }
}

function formatToolCount(server: McpServerInfo): string {
  if (server.status === 'disabled') return '—';
  return `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`;
}

function formatToolsAvailable(count: number): string {
  return `${count} tool${count === 1 ? '' : 's'} available`;
}

function sortedServers(servers: readonly McpServerInfo[]): McpServerInfo[] {
  return servers.toSorted(
    (a, b) =>
      STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || a.name.localeCompare(b.name),
  );
}

function buildSummary(servers: readonly McpServerInfo[]): string {
  const counts: Partial<Record<McpServerInfo['status'], number>> = {};
  let toolsAvailable = 0;
  for (const server of servers) {
    counts[server.status] = (counts[server.status] ?? 0) + 1;
    if (server.status === 'connected') toolsAvailable += server.toolCount;
  }
  const parts: string[] = [];
  for (const status of SUMMARY_ORDER) {
    const n = counts[status];
    if (n === undefined || n === 0) continue;
    parts.push(`${n} ${STATUS_LABEL[status]}`);
  }
  parts.push(formatToolsAvailable(toolsAvailable));
  return parts.join(' · ');
}

export function buildMcpStatusReportLines(options: McpStatusReportOptions): string[] {
  const servers = sortedServers(options.servers);
  const colors = options.colors;
  const accent = chalk.hex(colors.primary).bold;
  const muted = chalk.hex(colors.textDim);
  const value = chalk.hex(colors.text);
  const error = chalk.hex(colors.error);

  const lines: string[] = [accent('Servers')];

  if (servers.length === 0) {
    lines.push(muted('  No MCP servers configured. Run /mcp-config to add one.'));
    return lines;
  }

  const nameWidth = Math.max('Name'.length, ...servers.map((server) => server.name.length));
  const statusWidth = Math.max(
    'Status'.length,
    ...servers.map((server) => STATUS_LABEL[server.status].length),
  );
  const transportWidth = Math.max(
    'Transport'.length,
    ...servers.map((server) => server.transport.length),
  );

  lines.push(
    `  ${muted('Name'.padEnd(nameWidth))}  ${muted('Status'.padEnd(statusWidth))}  ${muted(
      'Transport'.padEnd(transportWidth),
    )}  ${muted('Tools')}`,
  );

  for (const server of servers) {
    const status = statusPainter(
      server.status,
      colors,
    )(STATUS_LABEL[server.status].padEnd(statusWidth));
    lines.push(
      `  ${value(server.name.padEnd(nameWidth))}  ${status}  ${muted(
        server.transport.padEnd(transportWidth),
      )}  ${value(formatToolCount(server))}`,
    );

    if (
      server.status === 'failed' &&
      server.error !== undefined &&
      server.error.trim().length > 0
    ) {
      lines.push(`    ${muted('error:')} ${error(server.error.trim())}`);
    }
    if (server.status === 'needs-auth') {
      lines.push(`    ${muted('action:')} ${value(`run /mcp-config login ${server.name}`)}`);
    }
  }

  lines.push('');
  lines.push(`  ${value(buildSummary(servers))}`);
  lines.push(`  ${muted('Configure with')} ${value('/mcp-config')}`);

  return lines;
}
