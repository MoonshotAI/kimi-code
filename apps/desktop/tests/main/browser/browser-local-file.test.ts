import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({ stat: vi.fn() }));

import { stat } from 'node:fs/promises';
import { localFileAddressUrl, resolveLocalHtmlFileUrl } from '../../../src/main/browser/browser-local-file';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveLocalHtmlFileUrl', () => {
  it('gives up when the file stat never returns', async () => {
    vi.mocked(stat).mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const pending = resolveLocalHtmlFileUrl('/mnt/dead/report.html');
      const outcome = expect(pending).rejects.toThrow('browser-open-local-file: file validation timed out');
      await vi.advanceTimersByTimeAsync(10_001);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a missing path and a non-file path the same as before', async () => {
    vi.mocked(stat).mockRejectedValueOnce(new Error('ENOENT'));
    await expect(resolveLocalHtmlFileUrl('/work/site/missing.html')).rejects.toThrow('file not found');
    vi.mocked(stat).mockResolvedValueOnce({ isFile: () => false } as never);
    await expect(resolveLocalHtmlFileUrl('/work/site/folder.html')).rejects.toThrow('not a file');
  });

  it('accepts a regular HTML file and keeps the query and fragment', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);
    await expect(resolveLocalHtmlFileUrl('/work/site/index.html', '?tab=2#intro')).resolves.toBe('file:///work/site/index.html?tab=2#intro');
    await expect(resolveLocalHtmlFileUrl('file:///work/site/index.html?tab=2#intro')).resolves.toBe('file:///work/site/index.html?tab=2#intro');
  });
});

describe('localFileAddressUrl', () => {
  it('turns file URLs and absolute local paths into file URLs', () => {
    expect(localFileAddressUrl(' file:///Users/me/a.html?x=1#top ')).toBe('file:///Users/me/a.html?x=1#top');
    expect(localFileAddressUrl('/Users/me/my notes.txt', 'darwin')).toBe('file:///Users/me/my%20notes.txt');
    expect(localFileAddressUrl('C:\\Users\\me\\a.pdf', 'win32')).toBe('file:///C:/Users/me/a.pdf');
    expect(localFileAddressUrl('\\\\server\\share\\a.html', 'win32')).toBe('file://server/share/a.html');
  });

  it('leaves web addresses, searches and relative paths alone', () => {
    for (const address of ['https://example.com/', 'example.com', 'search words', 'docs/a.html', 'C:\\Users\\a.html']) {
      expect(localFileAddressUrl(address, 'darwin')).toBeNull();
    }
    expect(localFileAddressUrl('/Users/me/a.html', 'win32')).toBeNull();
    expect(localFileAddressUrl('C:relative.html', 'win32')).toBeNull();
  });
});
