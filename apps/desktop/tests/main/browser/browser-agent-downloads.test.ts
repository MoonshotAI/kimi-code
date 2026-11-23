import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentDownloadFallbackDirectory,
  agentDownloadLimit,
  agentDownloadLimitMessage,
  agentDownloadOverLimit,
  downloadsAccessFromError,
  probeDownloadsAccess,
  probeDownloadsAccessSync,
  resolveAgentDownloadLocation,
} from '../../../src/main/browser/browser-agent-downloads';
import { BROWSER_AGENT_DOWNLOAD_LIMIT_DEFAULT } from '../../../src/shared/browser-data';

const errno = (code: string) => Object.assign(new Error(code), { code });

describe('agent download location', () => {
  it('uses Downloads when access is granted or not checked yet', () => {
    expect(resolveAgentDownloadLocation({ access: 'granted', downloads: '/Users/me/Downloads', env: {} })).toEqual({ path: '/Users/me/Downloads', custom: false, fallback: false, access: 'granted' });
    expect(resolveAgentDownloadLocation({ access: 'unknown', downloads: '/Users/me/Downloads', env: {} })).toMatchObject({ path: '/Users/me/Downloads', fallback: false, access: 'unknown' });
  });

  it('falls back to the Kimi Code home when Downloads access is denied', () => {
    expect(resolveAgentDownloadLocation({ access: 'denied', downloads: '/Users/me/Downloads', env: {} })).toEqual({ path: join(homedir(), '.kimi-code', 'browser', 'downloads'), custom: false, fallback: true, access: 'denied' });
    expect(resolveAgentDownloadLocation({ access: 'denied', downloads: '/Users/me/Downloads', env: { KIMI_CODE_HOME: '/opt/kimi' } }).path).toBe(join('/opt/kimi', 'browser', 'downloads'));
    expect(agentDownloadFallbackDirectory({ KIMI_CODE_HOME: '' })).toBe(join(homedir(), '.kimi-code', 'browser', 'downloads'));
  });

  it('prefers a custom folder over Downloads and the fallback', () => {
    expect(resolveAgentDownloadLocation({ custom: '/Volumes/Work/agent', access: 'denied', downloads: '/Users/me/Downloads', env: {} })).toEqual({ path: '/Volumes/Work/agent', custom: true, fallback: false, access: 'denied' });
    expect(resolveAgentDownloadLocation({ custom: null, access: 'granted', downloads: '/Users/me/Downloads', env: {} }).custom).toBe(false);
  });

  it('treats only permission errors as denied access', async () => {
    expect(downloadsAccessFromError(errno('EPERM'))).toBe('denied');
    expect(downloadsAccessFromError(errno('EACCES'))).toBe('denied');
    expect(downloadsAccessFromError(errno('EROFS'))).toBe('denied');
    expect(downloadsAccessFromError(errno('ENOENT'))).toBe('granted');
    const root = mkdtempSync(join(tmpdir(), 'agent-downloads-'));
    try {
      expect(probeDownloadsAccessSync(root)).toBe('granted');
      await expect(probeDownloadsAccess(root)).resolves.toBe('granted');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('treats a readable Downloads folder without write access as denied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-downloads-'));
  try {
    chmodSync(root, 0o555);
    expect(probeDownloadsAccessSync(root)).toBe('denied');
    await expect(probeDownloadsAccess(root)).resolves.toBe('denied');
    chmodSync(root, 0o755);
    expect(probeDownloadsAccessSync(root)).toBe('granted');
    await expect(probeDownloadsAccess(root)).resolves.toBe('granted');
    expect(readdirSync(root)).toEqual([]);
  } finally {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('agent download size limit', () => {
  it('defaults to 1 GB and allows no limit', () => {
    expect(agentDownloadLimit(undefined)).toBe(BROWSER_AGENT_DOWNLOAD_LIMIT_DEFAULT);
    expect(BROWSER_AGENT_DOWNLOAD_LIMIT_DEFAULT).toBe(1_024 ** 3);
    expect(agentDownloadLimit(null)).toBeNull();
    expect(agentDownloadOverLimit(10 * 1_024 ** 3, null)).toBe(false);
    expect(agentDownloadOverLimit(0, 1_024)).toBe(false);
    expect(agentDownloadOverLimit(1_025, 1_024)).toBe(true);
  });

  it('explains a blocked download with its size and the limit', () => {
    expect(agentDownloadLimitMessage('disk.dmg', 1.2 * 1_024 ** 3, 500 * 1_024 ** 2, false)).toBe('Download of "disk.dmg" blocked: 1.2 GB exceeds the 500 MB agent download limit set in Settings. Ask the user to download it or raise the limit.');
    expect(agentDownloadLimitMessage('stream.bin', 501 * 1_024 ** 2, 500 * 1_024 ** 2, true)).toContain('it passed 501 MB and exceeds the 500 MB agent download limit');
  });
});
