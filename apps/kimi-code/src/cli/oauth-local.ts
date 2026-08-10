/**
 * Local Kimi identity helpers — device id + host headers, ported from
 * `@moonshot-ai/kimi-code-oauth` `identity.ts` / `managed-kimi-code.ts`
 * (G-3 CLI consumption cutover: the oauth package is retired, the host CLI
 * still needs the device-id / User-Agent glue for telemetry and update
 * rollouts until the TS host itself retires).
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, hostname, release, type } from 'node:os';
import { join } from 'node:path';

export const KIMI_CODE_PLATFORM = 'kimi_code_cli';

/** The managed kimi provider name (auth facade provider id). */
export const KIMI_CODE_PROVIDER_NAME = 'managed:kimi-code';

export interface KimiHostIdentity {
  readonly userAgentProduct: string;
  readonly version: string;
  readonly userAgentSuffix?: string | undefined;
}

interface KimiIdentityOptions extends KimiHostIdentity {
  readonly homeDir: string;
}

/** Read the stable device id previously minted for this machine. */
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

/** Mint (once) and persist the machine's stable device id. */
export function createKimiDeviceId(
  homeDir: string,
  options: { readonly onFirstLaunch?: ((id: string) => void) | undefined } = {},
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

/** Product User-Agent, e.g. `kimi-code-cli/1.2.3` (optionally suffixed). */
export function createKimiUserAgent(options: KimiHostIdentity): string {
  const product = requiredAsciiHeader(options.userAgentProduct, 'Kimi identity product');
  const version = requiredAsciiHeader(options.version, 'Kimi identity version');
  const suffix =
    options.userAgentSuffix === undefined ? undefined : asciiHeader(options.userAgentSuffix, '');
  return suffix === undefined || suffix.length === 0
    ? `${product}/${version}`
    : `${product}/${version} (${suffix})`;
}

/** Identity headers for outbound telemetry/update requests. */
export function createKimiDefaultHeaders(options: KimiIdentityOptions): Record<string, string> {
  return {
    'User-Agent': createKimiUserAgent(options),
    'X-Msh-Platform': KIMI_CODE_PLATFORM,
    'X-Msh-Version': requiredAsciiHeader(options.version, 'Kimi identity version'),
    'X-Msh-Device-Name': asciiHeader(hostname()),
    'X-Msh-Device-Model': asciiHeader(deviceModel()),
    'X-Msh-Os-Version': asciiHeader(release()),
    'X-Msh-Device-Id': createKimiDeviceId(options.homeDir),
  };
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
