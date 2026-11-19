import { randomUUID } from 'node:crypto';
import { readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BROWSER_AGENT_DOWNLOAD_LIMIT_DEFAULT, type BrowserAgentDownloadLocation, type BrowserDownloadsAccess } from '../../shared/browser-data';
import { formatDownloadBytes } from '../../shared/browser-download-status';

export function agentDownloadFallbackDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env['KIMI_CODE_HOME'] || join(homedir(), '.kimi-code'), 'browser', 'downloads');
}

export function resolveAgentDownloadLocation(options: {
  custom?: string | null;
  access: BrowserDownloadsAccess;
  downloads: string;
  env?: NodeJS.ProcessEnv;
}): BrowserAgentDownloadLocation {
  if (options.custom) return { path: options.custom, custom: true, fallback: false, access: options.access };
  if (options.access === 'denied') return { path: agentDownloadFallbackDirectory(options.env), custom: false, fallback: true, access: 'denied' };
  return { path: options.downloads, custom: false, fallback: false, access: options.access };
}

export function downloadsAccessFromError(error: unknown): BrowserDownloadsAccess {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EROFS' ? 'denied' : 'granted';
}

function writeProbePath(directory: string): string {
  return join(directory, `.kimi-code-write-probe-${randomUUID()}`);
}

export function probeDownloadsAccessSync(directory: string): BrowserDownloadsAccess {
  try {
    readdirSync(directory);
    const probe = writeProbePath(directory);
    writeFileSync(probe, '', { flag: 'wx' });
    try { unlinkSync(probe); } catch {}
    return 'granted';
  } catch (error) {
    return downloadsAccessFromError(error);
  }
}

export async function probeDownloadsAccess(directory: string): Promise<BrowserDownloadsAccess> {
  try {
    await readdir(directory);
    const probe = writeProbePath(directory);
    await writeFile(probe, '', { flag: 'wx' });
    await unlink(probe).catch(() => {});
    return 'granted';
  } catch (error) {
    return downloadsAccessFromError(error);
  }
}

export function agentDownloadLimit(preference: number | null | undefined): number | null {
  return preference === undefined ? BROWSER_AGENT_DOWNLOAD_LIMIT_DEFAULT : preference;
}

export function agentDownloadOverLimit(bytes: number, limit: number | null): boolean {
  return limit !== null && bytes > limit;
}

export function agentDownloadLimitMessage(name: string, bytes: number, limit: number, streaming: boolean): string {
  const size = streaming ? `it passed ${formatDownloadBytes(bytes)} and exceeds` : `${formatDownloadBytes(bytes)} exceeds`;
  return `Download of ${JSON.stringify(name)} blocked: ${size} the ${formatDownloadBytes(limit)} agent download limit set in Settings. Ask the user to download it or raise the limit.`;
}
