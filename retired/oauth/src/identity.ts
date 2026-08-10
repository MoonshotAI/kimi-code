/**
 * Kimi host and device identity header factories.
 *
 * The caller owns the host identity (product name + host app version)
 * and the `homeDir` where the stable device id is stored. This module
 * intentionally keeps no global CLI version or environment-derived
 * production state.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, hostname, release, type } from 'node:os';
import { join } from 'node:path';

import type { DeviceHeaders } from './types';

export const KIMI_CODE_PLATFORM = 'kimi_code_cli';

export interface KimiHostIdentity {
  readonly userAgentProduct: string;
  readonly version: string;
  readonly userAgentSuffix?: string | undefined;
}

export interface KimiIdentityOptions extends KimiHostIdentity {
  readonly homeDir: string;
}

export interface CreateKimiDeviceIdOptions {
  /** Invoked synchronously the first time a device id is minted on this machine. */
  readonly onFirstLaunch?: ((id: string) => void) | undefined;
}

export function readKimiDeviceId(homeDir: string): string | null {
  const deviceIdPath = join(homeDir, 'device_id');
  if (!existsSync(deviceIdPath)) return null;
  try {
    const text = readFileSync(deviceIdPath, 'utf-8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export function createKimiDeviceId(
  homeDir: string,
  options: CreateKimiDeviceIdOptions = {},
): string {
  const existing = readKimiDeviceId(homeDir);
  if (existing !== null) return existing;

  const id = randomUUID();
  try {
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(homeDir, 'device_id'), id, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Best-effort: requests can still use the in-memory id.
  }
  if (options.onFirstLaunch !== undefined) {
    try {
      options.onFirstLaunch(id);
    } catch {
      // Telemetry callback must not affect device id creation.
    }
  }
  return id;
}

export function createKimiDeviceHeaders(options: {
  readonly homeDir: string;
  readonly version: string;
}): DeviceHeaders {
  return {
    'X-Msh-Platform': KIMI_CODE_PLATFORM,
    'X-Msh-Version': requiredAsciiHeader(options.version, 'Kimi identity version'),
    'X-Msh-Device-Name': asciiHeader(hostname()),
    'X-Msh-Device-Model': asciiHeader(deviceModel()),
    'X-Msh-Os-Version': asciiHeader(release()),
    'X-Msh-Device-Id': createKimiDeviceId(options.homeDir),
  };
}

export function createKimiUserAgent(options: {
  readonly userAgentProduct: string;
  readonly version: string;
  readonly userAgentSuffix?: string | undefined;
}): string {
  const product = requiredAsciiHeader(options.userAgentProduct, 'Kimi identity product');
  const version = requiredAsciiHeader(options.version, 'Kimi identity version');
  const suffix =
    options.userAgentSuffix === undefined ? undefined : asciiHeader(options.userAgentSuffix, '');
  return suffix === undefined || suffix.length === 0
    ? `${product}/${version}`
    : `${product}/${version} (${suffix})`;
}

export function createKimiDefaultHeaders(options: KimiIdentityOptions): Record<string, string> {
  return {
    'User-Agent': createKimiUserAgent(options),
    ...createKimiDeviceHeaders({
      homeDir: options.homeDir,
      version: options.version,
    }),
  };
}

/**
 * Env var carrying extra headers applied to every outbound provider request
 * (LLM chat and `/models` listing). Mirrors `ANTHROPIC_CUSTOM_HEADERS`:
 * newline-separated `Name: Value` lines; lines without a colon are skipped;
 * names and values are trimmed.
 *
 * These headers form the lowest-precedence layer — the Kimi identity headers
 * (User-Agent, X-Msh-*), per-provider `customHeaders`, and request auth
 * (Authorization) all override them.
 *
 * Unlike the device identity headers above, this is intentionally
 * environment-derived and stateless (re-read on every call) so callers can
 * apply it uniformly without plumbing the value through every host layer.
 */
export const KIMI_CODE_CUSTOM_HEADERS_ENV = 'KIMI_CODE_CUSTOM_HEADERS';

export function parseKimiCodeCustomHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const raw = env[KIMI_CODE_CUSTOM_HEADERS_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return {};
  const headers: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (name.length === 0) continue;
    headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

export function assertKimiHostIdentity(identity: KimiHostIdentity | undefined): KimiHostIdentity {
  if (identity === undefined) {
    throw new Error('Kimi host identity is required. Pass the host product name and version.');
  }
  requiredAsciiHeader(identity.userAgentProduct, 'Kimi identity product');
  requiredAsciiHeader(identity.version, 'Kimi identity version');
  return identity;
}

function deviceModel(): string {
  const os = type();
  const version = release();
  const osArch = arch();
  if (os === 'Darwin') return `macOS ${macOsProductVersion() ?? version} ${osArch}`;
  if (os === 'Windows_NT') return `Windows ${version} ${osArch}`;
  return `${os} ${version} ${osArch}`.trim();
}

function macOsProductVersion(): string | undefined {
  try {
    const version = execFileSync('/usr/bin/sw_vers', ['-productVersion'], {
      encoding: 'utf-8',
      timeout: 1000,
    }).trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

function asciiHeader(value: string, fallback = 'unknown'): string {
  const cleaned = value.replaceAll(/[^\u0020-\u007E]/g, '').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function requiredAsciiHeader(value: string, fieldName: string): string {
  const cleaned = asciiHeader(value, '');
  if (cleaned.length === 0) {
    throw new Error(`${fieldName} must be a non-empty ASCII string.`);
  }
  return cleaned;
}
