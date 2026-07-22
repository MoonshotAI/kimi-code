/**
 * Shared helpers for `kimi web` and its subcommands.
 *
 * Owns the default host/port, option parsers, and health/readiness probes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ServerLogLevel } from '@moonshot-ai/kap-server';

export const LOCAL_SERVER_HOST = '127.0.0.1';
export const DEFAULT_LAN_HOST = '0.0.0.0';
export const DEFAULT_SERVER_HOST = LOCAL_SERVER_HOST;
export const DEFAULT_SERVER_PORT = 58627;
export const DEFAULT_SERVER_ORIGIN = serverOrigin(DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT);

/** Filename (under KIMI_CODE_HOME) of the persistent server bearer token. */
export const SERVER_TOKEN_FILE = 'server.token';

export const DEFAULT_LOG_LEVEL: ServerLogLevel = 'info';
export const DEFAULT_FOREGROUND_LOG_LEVEL: ServerLogLevel = 'silent';

export const VALID_LOG_LEVELS: readonly ServerLogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

export interface ParsedServerOptions {
  host: string;
  port: number;
  logLevel: ServerLogLevel;
  debugEndpoints: boolean;
  /** Allow a non-loopback bind without a TLS-terminating reverse proxy. */
  insecureNoTls: boolean;
  /** Allow `POST /api/v1/shutdown` on a non-loopback bind. */
  allowRemoteShutdown: boolean;
  /** Allow PTY `/api/v1/terminals/*` routes on a non-loopback bind. */
  allowRemoteTerminals: boolean;
  /** Disable bearer-token auth on every route (`--dangerous-bypass-auth`). */
  dangerousBypassAuth: boolean;
  /** Extra `Host` header values to allow through the DNS-rebinding check. */
  allowedHosts: readonly string[];
}

export interface ServerCliOptions {
  host?: string | boolean;
  port?: string;
  logLevel?: string;
  debugEndpoints?: boolean;
  /** Allow a non-loopback bind without TLS (`--insecure-no-tls`). */
  insecureNoTls?: boolean;
  /** Allow remote shutdown on a non-loopback bind (`--allow-remote-shutdown`). */
  allowRemoteShutdown?: boolean;
  /** Allow remote terminals on a non-loopback bind (`--allow-remote-terminals`). */
  allowRemoteTerminals?: boolean;
  /** Disable bearer-token auth on every route (`--dangerous-bypass-auth`). */
  dangerousBypassAuth?: boolean;
  /** Extra `Host` header values to allow (`--allowed-host`). */
  allowedHost?: string[];
}

export function parseServerOptions(opts: ServerCliOptions): ParsedServerOptions {
  return {
    host: parseHost(opts.host),
    port: parsePort(opts.port, '--port', DEFAULT_SERVER_PORT),
    logLevel: parseLogLevel(opts.logLevel ?? DEFAULT_FOREGROUND_LOG_LEVEL),
    debugEndpoints: opts.debugEndpoints === true,
    insecureNoTls: opts.insecureNoTls !== false,
    allowRemoteShutdown: opts.allowRemoteShutdown === true,
    allowRemoteTerminals: opts.allowRemoteTerminals === true,
    dangerousBypassAuth: opts.dangerousBypassAuth === true,
    allowedHosts: parseAllowedHostArgs(opts.allowedHost),
  };
}

export function parseAllowedHostArgs(raw: readonly string[] | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseHost(raw: string | boolean | undefined): string {
  if (raw === undefined || raw === false) return DEFAULT_SERVER_HOST;
  if (raw === true || raw === '') return DEFAULT_LAN_HOST;
  return raw;
}

export function parsePort(raw: string | undefined, label: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) {
    throw new Error(`error: invalid ${label} value: ${raw}`);
  }
  return n;
}

export function parseLogLevel(raw: string | undefined): ServerLogLevel {
  if (raw === undefined) return DEFAULT_LOG_LEVEL;
  if ((VALID_LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as ServerLogLevel;
  }
  throw new Error(
    `error: invalid --log-level value: ${raw} (allowed: ${VALID_LOG_LEVELS.join(', ')})`,
  );
}

export function serverOrigin(host: string, port: number): string {
  return `http://${host}:${port}`;
}

/** Strip `/api/v1` and trailing slashes so user-supplied origins are uniform. */
export function normalizeServerOrigin(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/**
 * Read the persistent bearer token for the server.
 *
 * The server writes `<homeDir>/server.token` (0600) on first boot and reuses
 * it across restarts (ROADMAP M5.1); CLI commands that hit a gated REST route
 * read it back here and send it as `Authorization: Bearer <token>`. `homeDir`
 * is the CLI's own KIMI_CODE_HOME resolution (`getDataDir()`).
 *
 * Throws a clear error when the file is missing/unreadable — the usual cause
 * is a server that has never been started (no token file yet), or an older
 * build that predates token auth.
 */
export function resolveServerToken(homeDir: string): string {
  const tokenPath = join(homeDir, SERVER_TOKEN_FILE);
  try {
    return readFileSync(tokenPath, 'utf8').trim();
  } catch (error) {
    throw new Error(
      `unable to read server token at ${tokenPath}; has the server been started at least once?`,
      { cause: error },
    );
  }
}

/** Best-effort token read: returns `undefined` instead of throwing. */
export function tryResolveServerToken(homeDir: string): string | undefined {
  try {
    return resolveServerToken(homeDir);
  } catch {
    return undefined;
  }
}

/** An `Authorization: Bearer <token>` header bag for `fetch`. */
export function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
