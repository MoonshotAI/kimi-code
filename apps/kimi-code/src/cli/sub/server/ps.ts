/**
 * `kimi server ps` — list clients currently connected to the running server.
 *
 * Talks to the running server over HTTP (`GET /api/v1/connections`) using the
 * single-instance lock (`~/.kimi-code/server/lock`) to discover its origin —
 * the same way `kimi web` locates the daemon.
 */

import chalk from 'chalk';
import type { Command } from 'commander';

import { getLiveLock } from '@moonshot-ai/server';

import { lockConnectHost } from './daemon';
import { isServerHealthy, serverOrigin } from './shared';

/** Wire shape of a single connection returned by `GET /api/v1/connections`. */
interface ConnectionInfo {
  id: string;
  connected_at: string;
  remote_address: string | null;
  user_agent: string | null;
  has_client_hello: boolean;
  subscriptions: string[];
}

interface ConnectionsEnvelope {
  code: number;
  msg: string;
  data?: { connections?: ConnectionInfo[] };
}

const HEALTH_TIMEOUT_MS = 1500;
const FETCH_TIMEOUT_MS = 5000;
const USER_AGENT_MAX_WIDTH = 40;

export function registerPsCommand(server: Command): void {
  server
    .command('ps')
    .description('List clients currently connected to the running Kimi server.')
    .option('--json', 'Print the raw connection list as JSON.')
    .action(async (opts: { json?: boolean }) => {
      try {
        await handlePsCommand(opts);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

async function handlePsCommand(opts: { json?: boolean }): Promise<void> {
  const lock = getLiveLock();
  if (!lock) {
    throw new Error(
      'No running Kimi server. Start one with `kimi server run` or `kimi web`.',
    );
  }

  const origin = serverOrigin(lockConnectHost(lock), lock.port);
  if (!(await isServerHealthy(origin, HEALTH_TIMEOUT_MS))) {
    throw new Error(`Kimi server at ${origin} is not responding.`);
  }

  const connections = await fetchConnections(origin);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(connections, null, 2)}\n`);
    return;
  }
  process.stdout.write(formatTable(connections));
}

async function fetchConnections(origin: string): Promise<ConnectionInfo[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/api/v1/connections`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Failed to list clients: HTTP ${String(res.status)} from ${origin}.`);
    }
    const body = (await res.json()) as ConnectionsEnvelope;
    if (body.code !== 0) {
      throw new Error(`Failed to list clients: ${body.msg}`);
    }
    return body.data?.connections ?? [];
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timed out listing clients from ${origin}.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function formatTable(connections: ConnectionInfo[]): string {
  if (connections.length === 0) {
    return 'No active clients.\n';
  }

  const header = ['ID', 'CONNECTED', 'REMOTE', 'USER_AGENT', 'SESSIONS', 'HELLO'];
  const rows = connections.map((c) => [
    c.id,
    formatAge(c.connected_at),
    c.remote_address ?? '-',
    truncate(c.user_agent ?? '-', USER_AGENT_MAX_WIDTH),
    String(c.subscriptions.length),
    c.has_client_hello ? 'yes' : 'no',
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const formatRow = (cells: string[]): string =>
    cells.map((cell, i) => cell + ' '.repeat(Math.max(0, widths[i]! - cell.length))).join('  ');

  const lines = [chalk.bold(formatRow(header)), ...rows.map(formatRow)];
  return `${lines.join('\n')}\n`;
}

function formatAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}
