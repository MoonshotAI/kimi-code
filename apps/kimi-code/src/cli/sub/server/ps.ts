/**
 * `kimi server ps` — list clients currently connected to the running servers.
 *
 * Talks to every live server over HTTP (`GET /api/v1/connections`) using the
 * instance registry (`~/.kimi-code/server/instances/`) to discover origins,
 * and prints one section per server id. The bearer token is home-wide, so one
 * token reaches every instance. An unreachable instance degrades to a
 * per-server note instead of failing the whole listing.
 */

import chalk from 'chalk';
import type { Command } from 'commander';

import { listLiveServerInstances, type ServerInstanceInfo } from '@moonshot-ai/kap-server';

import { getDataDir } from '#/utils/paths';

import { instanceConnectHost } from './daemon';
import { authHeaders, isServerHealthy, resolveServerToken, serverOrigin } from './shared';

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
    .description('List clients currently connected to each running Kimi server.')
    .option('--json', 'Print the raw per-server connection lists as JSON.')
    .action(async (opts: { json?: boolean }) => {
      try {
        await handlePsCommand(opts);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

/** One instance's listing outcome: its connections, or why they could not be fetched. */
interface ServerConnections {
  instance: ServerInstanceInfo;
  origin: string;
  connections?: ConnectionInfo[];
  error?: string;
}

async function handlePsCommand(opts: { json?: boolean }): Promise<void> {
  const instances = await listLiveServerInstances();
  if (instances.length === 0) {
    throw new Error(
      'No running Kimi server. Start one with `kimi server run` or `kimi web`.',
    );
  }

  // The `/api/v1/connections` route is gated by bearer auth (M5.1); the
  // persistent token is home-wide, so one read reaches every instance. A clear
  // error here means the server has never been started (no token file yet) or
  // the token file was removed.
  const token = resolveServerToken(getDataDir());

  const sections: ServerConnections[] = [];
  for (const instance of instances) {
    const origin = serverOrigin(instanceConnectHost(instance), instance.port);
    if (!(await isServerHealthy(origin, HEALTH_TIMEOUT_MS))) {
      sections.push({ instance, origin, error: 'server is not responding' });
      continue;
    }
    try {
      sections.push({ instance, origin, connections: await fetchConnections(origin, token) });
    } catch (error) {
      sections.push({
        instance,
        origin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ servers: sections.map(toJsonSection) }, null, 2)}\n`);
    return;
  }
  process.stdout.write(formatSections(sections));
}

function toJsonSection(section: ServerConnections): Record<string, unknown> {
  const base: Record<string, unknown> = {
    server_id: section.instance.serverId,
    pid: section.instance.pid,
    host: section.instance.host,
    port: section.instance.port,
    origin: section.origin,
  };
  if (section.error !== undefined) {
    return { ...base, error: section.error };
  }
  return { ...base, connections: section.connections ?? [] };
}

function formatSections(sections: ServerConnections[]): string {
  return (
    sections
      .map((section) => {
        const header = `server ${section.instance.serverId} (pid ${String(section.instance.pid)}, ${section.origin})`;
        if (section.error !== undefined) {
          return `${header}\n${section.error}\n`;
        }
        return `${header}\n${formatTable(section.connections ?? [])}`;
      })
      .join('\n')
  );
}

async function fetchConnections(origin: string, token: string): Promise<ConnectionInfo[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/api/v1/connections`, {
      headers: authHeaders(token),
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
