import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installDownloadHandler, setAutomaticDownloadPath } from '../../../src/main/browser/downloads';

interface FakeItem {
  getFilename: () => string;
  setSavePath: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}

function fakeSession() {
  const listeners: ((event: unknown, item: unknown) => void)[] = [];
  return {
    session: {
      on: (channel: string, listener: (event: unknown, item: unknown) => void) => {
        if (channel === 'will-download') listeners.push(listener);
      },
    },
    fireDownload: (item: FakeItem) => {
      for (const listener of listeners) listener({}, item);
    },
    listenerCount: () => listeners.length,
  };
}

function fakeItem(fileName: string): FakeItem {
  return {
    getFilename: () => fileName,
    setSavePath: vi.fn(),
    cancel: vi.fn(),
  };
}

function makeDeps(showSaveDialog: (opts: { defaultPath: string }) => string | undefined) {
  return {
    showSaveDialog: vi.fn(showSaveDialog),
    downloadsDir: '/Users/x/Downloads',
  };
}

describe('installDownloadHandler', () => {
  it('offers the system downloads dir plus the suggested filename on the first download', () => {
    const { session, fireDownload } = fakeSession();
    const deps = makeDeps(() => '/Users/x/Downloads/kimi-session.zip');
    installDownloadHandler(session as any, deps);
    fireDownload(fakeItem('kimi-session.zip'));
    expect(deps.showSaveDialog).toHaveBeenCalledWith({
      defaultPath: join('/Users/x/Downloads', 'kimi-session.zip'),
    });
  });

  it('writes the download to the path the user chose', () => {
    const { session, fireDownload } = fakeSession();
    const deps = makeDeps(() => '/Users/x/Desktop/report.zip');
    installDownloadHandler(session as any, deps);
    const item = fakeItem('kimi-session.zip');
    fireDownload(item);
    expect(item.setSavePath).toHaveBeenCalledWith('/Users/x/Desktop/report.zip');
    expect(item.cancel).not.toHaveBeenCalled();
  });

  it('cancels the download (nothing lands on disk) when the user dismisses the dialog', () => {
    const { session, fireDownload } = fakeSession();
    const deps = makeDeps(() => undefined);
    installDownloadHandler(session as any, deps);
    const item = fakeItem('kimi-session.zip');
    fireDownload(item);
    expect(item.cancel).toHaveBeenCalledOnce();
    expect(item.setSavePath).not.toHaveBeenCalled();
  });

  it('remembers the last chosen directory for subsequent downloads', () => {
    const { session, fireDownload } = fakeSession();
    const deps = makeDeps(() => '/Users/x/Desktop/a.zip');
    installDownloadHandler(session as any, deps);
    fireDownload(fakeItem('a.zip'));
    fireDownload(fakeItem('trace.jsonl'));
    expect(deps.showSaveDialog).toHaveBeenLastCalledWith({
      defaultPath: join('/Users/x/Desktop', 'trace.jsonl'),
    });
  });

  it('falls back to the downloads dir after a cancelled dialog', () => {
    const { session, fireDownload } = fakeSession();
    let choice: string | undefined;
    const deps = makeDeps(() => choice);
    installDownloadHandler(session as any, deps);
    choice = '/Users/x/Desktop/a.zip';
    fireDownload(fakeItem('a.zip'));
    choice = undefined;
    fireDownload(fakeItem('b.zip'));
    choice = '/Users/x/Desktop/c.zip';
    fireDownload(fakeItem('c.zip'));
    expect(deps.showSaveDialog).toHaveBeenLastCalledWith({
      defaultPath: join('/Users/x/Desktop', 'c.zip'),
    });
  });

  it('installs only once per session (re-created windows must not double-prompt)', () => {
    const { session, listenerCount } = fakeSession();
    const deps = makeDeps(() => '/x/a.zip');
    installDownloadHandler(session as any, deps);
    installDownloadHandler(session as any, deps);
    expect(listenerCount()).toBe(1);
  });
});

it('assigns automatic downloads distinct paths without replacing existing files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-download-path-'));
  try {
    writeFileSync(join(directory, 'report.zip'), 'original');
    const make = () => ({ ...fakeItem('../report.zip'), once: vi.fn() });
    const first = make();
    const second = make();
    setAutomaticDownloadPath(first as never, directory);
    setAutomaticDownloadPath(second as never, directory);
    expect(first.setSavePath).toHaveBeenCalledWith(join(directory, 'report (1).zip'));
    expect(second.setSavePath).toHaveBeenCalledWith(join(directory, 'report (2).zip'));
    expect(readFileSync(join(directory, 'report.zip'), 'utf8')).toBe('original');
    for (const item of [first, second]) (item.once.mock.calls[0]![1] as () => void)();
    const later = make();
    setAutomaticDownloadPath(later as never, directory);
    expect(later.setSavePath).toHaveBeenCalledWith(join(directory, 'report (1).zip'));
    (later.once.mock.calls[0]![1] as () => void)();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('lets the filesystem distinguish concurrent names and retains completed empty downloads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-download-case-'));
  try {
    const first = { ...fakeItem('report.zip'), once: vi.fn() };
    const second = { ...fakeItem('REPORT.zip'), once: vi.fn() };
    setAutomaticDownloadPath(first as never, directory);
    setAutomaticDownloadPath(second as never, directory);
    const firstPath = first.setSavePath.mock.calls[0]![0] as string;
    const secondPath = second.setSavePath.mock.calls[0]![0] as string;
    writeFileSync(firstPath, 'first');
    writeFileSync(secondPath, 'second');
    expect(readFileSync(firstPath, 'utf8')).toBe('first');
    expect(readFileSync(secondPath, 'utf8')).toBe('second');
    const empty = { ...fakeItem('empty.txt'), once: vi.fn() };
    setAutomaticDownloadPath(empty as never, directory);
    (empty.once.mock.calls[0]![1] as (event: unknown, state: string) => void)({}, 'completed');
    expect(readFileSync(join(directory, 'empty.txt')).byteLength).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
