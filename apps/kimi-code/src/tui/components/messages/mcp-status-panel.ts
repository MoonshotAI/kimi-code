import type { McpServerEntry, McpServerStatus } from '@moonshot-ai/harness-core';

import { currentTheme } from '#/tui/theme';

export interface McpStatusReportOptions {
  readonly servers: readonly McpServerEntry[];
}

const STATUS_PRIORITY: Record<McpServerStatus, number> = {
  failed: 0,
  'needs-auth': 1,
  pending: 2,
  connected: 3,
  disabled: 4,
  removed: 5,
};

const STATUS_LABEL: Record<McpServerStatus, string> = {
  connected: 'connected',
  pending: 'pending',
  'needs-auth': 'needs auth',
  failed: 'failed',
  disabled: 'disabled',
  removed: 'removed',
};

const SUMMARY_ORDER: readonly McpServerStatus[] = [
  'connected',
  'pending',
  'needs-auth',
  'failed',
  'disabled',
  'removed',
];

function statusPainter(status: McpServerStatus): (text: string) => string {
  switch (status) {
    case 'connected':
      return (text) => currentTheme.fg('success', text);
    case 'failed':
      return (text) => currentTheme.fg('error', text);
    case 'needs-auth':
    case 'pending':
      return (text) => currentTheme.fg('warning', text);
    case 'disabled':
    case 'removed':
      return (text) => currentTheme.fg('textDim', text);
  }
}

function formatToolCount(server: McpServerEntry): string {
  if (server.status === 'disabled' || server.status === 'removed') return '—';
  return `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`;
}

function formatToolsAvailable(count: number): string {
  return `${count} tool${count === 1 ? '' : 's'} available`;
}

function formatErrorLine(error: string): string {
  return error.trim().replaceAll(/\s+/g, ' ');
}

function sortedServers(servers: readonly McpServerEntry[]): McpServerEntry[] {
  return servers.toSorted(
    (a, b) =>
      STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || a.name.localeCompare(b.name),
  );
}

export function buildMcpServersSummary(servers: readonly McpServerEntry[]): string {
  const counts: Partial<Record<McpServerStatus, number>> = {};
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
  const accent = (text: string) => currentTheme.boldFg('primary', text);
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const error = (text: string) => currentTheme.fg('error', text);

  const lines: string[] = [accent('Servers')];

  if (servers.length === 0) {
    lines.push(muted('  No MCP servers configured.'));
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
    const status = statusPainter(server.status)(STATUS_LABEL[server.status].padEnd(statusWidth));
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
      lines.push(`    ${muted('error:')} ${error(formatErrorLine(server.error))}`);
    }
    if (server.status === 'needs-auth') {
      lines.push(`    ${muted('action:')} ${value('authorize in the browser when the agent runs the server\'s authenticate flow')}`);
    }
  }

  lines.push('');
  lines.push(`  ${value(buildMcpServersSummary(servers))}`);

  return lines;
}
