import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

import { installDownloadHandler } from '../../src/main/downloads';

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installDownloadHandler(session as any, deps);
    fireDownload(fakeItem('kimi-session.zip'));
    expect(deps.showSaveDialog).toHaveBeenCalledWith({
      defaultPath: join('/Users/x/Downloads', 'kimi-session.zip'),
    });
  });

  it('writes the download to the path the user chose', () => {
    const { session, fireDownload } = fakeSession();
    const deps = makeDeps(() => '/Users/x/Desktop/report.zip');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installDownloadHandler(session as any, deps);
    const item = fakeItem('kimi-session.zip');
    fireDownload(item);
    expect(item.setSavePath).toHaveBeenCalledWith('/Users/x/Desktop/report.zip');
    expect(item.cancel).not.toHaveBeenCalled();
  });

  it('cancels the download (nothing lands on disk) when the user dismisses the dialog', () => {
    const { session, fireDownload } = fakeSession();
    const deps = makeDeps(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installDownloadHandler(session as any, deps);
    const item = fakeItem('kimi-session.zip');
    fireDownload(item);
    expect(item.cancel).toHaveBeenCalledOnce();
    expect(item.setSavePath).not.toHaveBeenCalled();
  });

  it('remembers the last chosen directory for subsequent downloads', () => {
    const { session, fireDownload } = fakeSession();
    const deps = makeDeps(() => '/Users/x/Desktop/a.zip');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installDownloadHandler(session as any, deps);
    choice = '/Users/x/Desktop/a.zip';
    fireDownload(fakeItem('a.zip'));
    choice = undefined;
    fireDownload(fakeItem('b.zip'));
    choice = '/Users/x/Desktop/c.zip';
    fireDownload(fakeItem('c.zip'));
    // A cancelled dialog must not clobber the remembered directory.
    expect(deps.showSaveDialog).toHaveBeenLastCalledWith({
      defaultPath: join('/Users/x/Desktop', 'c.zip'),
    });
  });

  it('installs only once per session (re-created windows must not double-prompt)', () => {
    const { session, listenerCount } = fakeSession();
    const deps = makeDeps(() => '/x/a.zip');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installDownloadHandler(session as any, deps);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installDownloadHandler(session as any, deps);
    expect(listenerCount()).toBe(1);
  });
});
