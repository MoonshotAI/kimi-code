import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolve KIMI_CODE_HOME (env > ~/.kimi-code). */
export function resolveKimiCodeHome(): string {
  const envHome = process.env['KIMI_CODE_HOME'];
  if (envHome !== undefined && envHome.length > 0) {
    return envHome;
  }
  return join(homedir(), '.kimi-code');
}

/** HTTP port for the vis API server. */
export function resolvePort(): number {
  const raw = process.env['PORT'];
  if (raw !== undefined && raw.length > 0) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) {
      return n;
    }
  }
  return 3001;
}

/** HTTP host for the vis API server. Defaults to loopback. */
export function resolveHost(): string {
  const raw = process.env['VIS_HOST'] ?? process.env['HOST'];
  const host = raw?.trim();
  return host !== undefined && host.length > 0 ? host : '127.0.0.1';
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replaceAll('[', '').replaceAll(']', '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('127.')
  );
}

/** Format a host for embedding in a URL authority. Bare IPv6 literals (which
 *  contain ':') must be bracketed, e.g. `::1` → `[::1]`, otherwise
 *  `http://::1:3001/` is an invalid URL. Already-bracketed literals, IPv4
 *  addresses, and hostnames are returned unchanged. */
export function hostForUrl(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

export function resolveVisAuthToken(host: string = resolveHost()): string | undefined {
  const raw = process.env['VIS_AUTH_TOKEN'];
  const token = raw?.trim();
  if (token !== undefined && token.length > 0) return token;
  if (!isLoopbackHost(host)) {
    throw new Error(
      `VIS_AUTH_TOKEN is required when binding vis-server outside loopback (host=${host})`,
    );
  }
  return undefined;
}

export const KIMI_CODE_HOME: string = resolveKimiCodeHome();
