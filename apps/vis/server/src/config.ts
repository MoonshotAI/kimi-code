import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolve KIMI_CODE_HOME (env > ~/.kimi-code). */
function resolveKimiCodeHome(): string {
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

/** Strict dotted-quad match for the 127.0.0.0/8 loopback range. Anchored so a
 *  hostname that merely *starts with* `127.` (e.g. `127.0.0.1.nip.io`) is not
 *  mistaken for a loopback address. */
const LOOPBACK_IPV4 = /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){2}$/u;

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replaceAll('[', '').replaceAll(']', '');
  return (
    normalized === 'localhost' ||
    // RFC 6761: `localhost.` and any `*.localhost` name resolves to loopback.
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    LOOPBACK_IPV4.test(normalized)
  );
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
