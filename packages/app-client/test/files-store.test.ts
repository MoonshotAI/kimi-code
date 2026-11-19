import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KimiWebApi } from '@moonshot-ai/app-core/api';
import { DaemonApiError } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { noopProductTracker, setProductTracker } from '../src/contracts';
import { filesStore, setFilesHooks } from '../src/stores/files';
import { sessionsStore } from '../src/stores/sessions';
import { workspacesStore } from '../src/stores/workspaces';

const apiMock = {
  listDirectory: vi.fn(),
  listWorkspaceDirectory: vi.fn(),
  suggestFiles: vi.fn(),
  suggestFilesAtRoots: vi.fn(),
  readFile: vi.fn(),
  readHostFileContent: vi.fn(),
  downloadSessionFile: vi.fn(),
  downloadHostFile: vi.fn(),
  getFileDownloadUrl: vi.fn(),
  openFile: vi.fn(),
  revealFile: vi.fn(),
  getGitStatus: vi.fn(),
  getFileDiff: vi.fn(),
};

function resetStores(): void {
  sessionsStore().setSessions([]);
  sessionsStore().setActiveSessionId(undefined);
  workspacesStore().workspaces = [];
  workspacesStore().storedActiveWorkspaceId = null;
  filesStore().fileTreeRootByWorkspace = {};
  filesStore().gitStatusBySessionRoot = {};
  filesStore().clearFileDiff();
  setProductTracker(noopProductTracker);
}

beforeEach(() => {
  resetStores();
  for (const mock of Object.values(apiMock)) mock.mockReset();
  setKimiClientDeps({ api: () => apiMock as unknown as KimiWebApi });
});

afterEach(() => {
  resetKimiClientDeps();
  setFilesHooks(null);
  setProductTracker(noopProductTracker);
});

describe('filesStore loadGitStatus', () => {
  beforeEach(() => {
    filesStore().gitStatusBySession = {};
    sessionsStore().setSessions([{ id: 's1', cwd: '/repo' } as never]);
  });

  it('preserves the existing API call shape without options', async () => {
    apiMock.getGitStatus.mockResolvedValue({ available: true, entries: [], pullRequest: null });
    await filesStore().loadGitStatus('s1');
    expect(apiMock.getGitStatus).toHaveBeenCalledWith('s1');
    expect(filesStore().gitStatusBySession.s1).toBeDefined();
  });

  it('skips an already cancelled read', async () => {
    await filesStore().loadGitStatus('s1', { signal: AbortSignal.abort() });
    expect(apiMock.getGitStatus).not.toHaveBeenCalled();
  });

  it('does not let an aborted A-B-A read overwrite git status or pull request metadata', async () => {
    const controller = new AbortController();
    const options = { signal: controller.signal, background: true };
    let resolveFirst!: (value: unknown) => void;
    const current = {
      available: true,
      entries: [],
      pullRequest: { number: 2, state: 'open', url: 'https://example.com/pull/2' },
    };
    apiMock.getGitStatus
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(current);

    const first = filesStore().loadGitStatus('s1', options);
    expect(apiMock.getGitStatus).toHaveBeenCalledWith('s1', undefined, options);
    controller.abort();
    await filesStore().loadGitStatus('s2');
    await filesStore().loadGitStatus('s1', { signal: new AbortController().signal });
    resolveFirst({ available: false, entries: [], pullRequest: null });
    await first;

    expect(filesStore().gitStatusBySession.s1).toEqual(current);
    expect(sessionsStore().sessions.find((session) => session.id === 's1')?.pullRequest).toEqual(current.pullRequest);
  });

  it('leaves the cache untouched and reports no failure on cancellation', async () => {
    const failure = vi.fn();
    setFilesHooks({ pushOperationFailure: failure });
    const controller = new AbortController();
    apiMock.getGitStatus.mockRejectedValue(new DOMException('cancelled', 'AbortError'));

    const pending = filesStore().loadGitStatus('s1', { signal: controller.signal });
    controller.abort();
    await pending;

    expect(filesStore().gitStatusBySession.s1).toBeUndefined();
    expect(failure).not.toHaveBeenCalled();
  });

  it('keeps root-scoped git status separate from the primary status', async () => {
    const primary = { branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null };
    const additional = { branch: 'feature', ahead: 1, behind: 0, entries: { 'src/a.ts': 'modified' }, additions: 2, deletions: 1, pullRequest: null };
    apiMock.getGitStatus.mockImplementation((_id, input) => Promise.resolve(input?.root === '/extra' ? additional : primary));

    await filesStore().loadGitStatus('s1');
    await filesStore().loadGitStatus('s1', { root: '/extra' });

    expect(apiMock.getGitStatus).toHaveBeenNthCalledWith(2, 's1', { root: '/extra' }, { root: '/extra' });
    expect(filesStore().gitStatusBySession.s1).toEqual(primary);
    expect(filesStore().gitStatusForRoot('s1', '/extra')).toEqual(additional);
  });

  it('ignores stale root responses after an A-B-A switch', async () => {
    const requests: Array<{ root: string; resolve: (value: unknown) => void }> = [];
    apiMock.getGitStatus.mockImplementation((_id, input) => new Promise((resolve) => {
      requests.push({ root: input.root, resolve });
    }));
    const firstA = filesStore().loadGitStatus('s1', { root: '/a' });
    const firstB = filesStore().loadGitStatus('s1', { root: '/b' });
    const secondA = filesStore().loadGitStatus('s1', { root: '/a' });
    const current = { branch: 'new-a', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null };

    requests[2]!.resolve(current);
    await secondA;
    requests[0]!.resolve({ ...current, branch: 'old-a' });
    await firstA;
    requests[1]!.resolve({ ...current, branch: 'b' });
    await firstB;

    expect(filesStore().gitStatusForRoot('s1', '/a')).toEqual(current);
    expect(filesStore().gitStatusForRoot('s1', '/b')?.branch).toBe('b');
  });
});

describe('filesStore loadFileDiff', () => {
  beforeEach(() => {
    sessionsStore().setActiveSessionId('s1');
    apiMock.getFileDiff.mockResolvedValue({ path: 'src/a.ts', diff: '', truncated: false });
    apiMock.readFile.mockResolvedValue({ path: '/extra/src/a.ts', content: '', encoding: 'utf-8', size: 0, isBinary: false });
  });

  it('passes root to the diff request and full-text fallback', async () => {
    await filesStore().loadFileDiff('src/a.ts', { root: '/extra' });

    expect(apiMock.getFileDiff).toHaveBeenCalledExactlyOnceWith(
      's1',
      'src/a.ts',
      { root: '/extra' },
      expect.objectContaining({ background: false }),
    );
    expect(apiMock.readFile).toHaveBeenCalledExactlyOnceWith('s1', {
      path: '/extra/src/a.ts',
      length: 10_485_760,
      allowExternalSymlinks: true,
    });
    expect(filesStore().fileDiffEmptyFile).toBe(true);
    expect(filesStore().selectedDiffRoot).toBe('/extra');
    filesStore().clearFileDiff();
    expect(filesStore().selectedDiffRoot).toBeUndefined();
  });

  it('keeps diff reads in the foreground and aborts superseded reads', async () => {
    await filesStore().loadFileDiff('src/a.ts');
    const firstOptions = apiMock.getFileDiff.mock.calls[0]?.[3];
    await filesStore().loadFileDiff('src/b.ts');
    const secondOptions = apiMock.getFileDiff.mock.calls[1]?.[3];

    expect(firstOptions?.background).toBe(false);
    expect(firstOptions?.signal.aborted).toBe(true);
    expect(secondOptions?.background).toBe(false);
    expect(secondOptions?.signal.aborted).toBe(false);
  });
});

describe('filesStore probeWorkspacePath', () => {
  it('probes a relative file through the session api', async () => {
    sessionsStore().setActiveSessionId('s1');
    apiMock.readFile.mockResolvedValue({});

    expect(await filesStore().probeWorkspacePath('src/a.ts', 'file')).toBe(true);
    expect(apiMock.readFile).toHaveBeenCalledWith('s1', {
      path: 'src/a.ts',
      length: 1,
      allowExternalSymlinks: true,
    });
  });

  it('probes a relative folder through listDirectory', async () => {
    sessionsStore().setActiveSessionId('s1');
    apiMock.listDirectory.mockResolvedValue({ items: [] });

    expect(await filesStore().probeWorkspacePath('src', 'folder')).toBe(true);
    expect(apiMock.listDirectory).toHaveBeenCalledWith('s1', {
      path: 'src',
      allowExternalSymlinks: true,
    });
  });

  it('returns false only for the path-not-found code', async () => {
    sessionsStore().setActiveSessionId('s1');
    apiMock.readFile.mockRejectedValue(new DaemonApiError({ code: 40409, msg: 'nope', requestId: 'r' }));
    expect(await filesStore().probeWorkspacePath('src/a.ts', 'file')).toBe(false);

    apiMock.readFile.mockRejectedValue(new DaemonApiError({ code: 500, msg: 'boom', requestId: 'r' }));
    expect(await filesStore().probeWorkspacePath('src/a.ts', 'file')).toBe(true);
  });

  it('reads absolute paths from the host without a session', async () => {
    apiMock.readHostFileContent.mockResolvedValue({ content: 'x' });

    expect(await filesStore().probeWorkspacePath('/etc/hosts', 'file')).toBe(true);
    expect(apiMock.readHostFileContent).toHaveBeenCalledWith('/etc/hosts');
    expect(apiMock.readFile).not.toHaveBeenCalled();
  });

  it('resolves a relative path against the first visible workspace without a session', async () => {
    workspacesStore().workspaces = [{ id: 'ws1', root: '/repo/ws1', name: 'ws1', sessionCount: 0 }];
    apiMock.readHostFileContent.mockResolvedValue({ content: 'x' });

    expect(await filesStore().probeWorkspacePath('docs/a.md', 'file')).toBe(true);
    expect(apiMock.readHostFileContent).toHaveBeenCalledWith('/repo/ws1/docs/a.md');
  });

  it('returns true when there is no workspace to resolve against', async () => {
    expect(await filesStore().probeWorkspacePath('docs/a.md', 'file')).toBe(true);
    expect(apiMock.readHostFileContent).not.toHaveBeenCalled();
  });
});

describe('filesStore readFileContent', () => {
  const readResult = {
    path: 'a.txt',
    content: 'hello',
    encoding: 'utf-8' as const,
    mime: 'text/plain',
    isBinary: false,
    size: 5,
    truncated: false,
    etag: 'e1',
  };

  it('requests the protocol-max length so previews are not silently truncated', async () => {
    sessionsStore().setActiveSessionId('s1');
    apiMock.readFile.mockResolvedValue(readResult);

    const file = await filesStore().readFileContent('a.txt');

    expect(apiMock.readFile).toHaveBeenCalledWith('s1', {
      path: 'a.txt',
      length: 10_485_760,
      allowExternalSymlinks: true,
    });
    expect(file).toMatchObject({ path: 'a.txt', truncated: false });
  });

  it('carries the truncated flag from the daemon response', async () => {
    sessionsStore().setActiveSessionId('s1');
    apiMock.readFile.mockResolvedValue({ ...readResult, truncated: true });

    const file = await filesStore().readFileContent('a.txt');

    expect(file?.truncated).toBe(true);
  });

  it('rethrows FS_TOO_LARGE so the caller can fall back to a streamed read', async () => {
    sessionsStore().setActiveSessionId('s1');
    apiMock.readFile.mockRejectedValue(new DaemonApiError({ code: 41302, msg: 'too large', requestId: 'r' }));

    await expect(filesStore().readFileContent('a.txt')).rejects.toMatchObject({ code: 41302 });
  });

  it('rethrows path-not-found and swallows other errors as null', async () => {
    sessionsStore().setActiveSessionId('s1');
    apiMock.readFile.mockRejectedValue(new DaemonApiError({ code: 40409, msg: 'nope', requestId: 'r' }));
    await expect(filesStore().readFileContent('a.txt')).rejects.toMatchObject({ code: 40409 });

    apiMock.readFile.mockRejectedValue(new Error('boom'));
    expect(await filesStore().readFileContent('a.txt')).toBeNull();
  });
});

describe('filesStore readWorkspaceFileBlob', () => {
  it('streams the file through the session download endpoint', async () => {
    sessionsStore().setActiveSessionId('s1');
    const blob = new Blob(['x'], { type: 'image/png' });
    apiMock.downloadSessionFile.mockResolvedValue(blob);

    expect(await filesStore().readWorkspaceFileBlob('img/a.png')).toBe(blob);
    expect(apiMock.downloadSessionFile).toHaveBeenCalledWith('s1', 'img/a.png', {
      prefixBytes: undefined,
      allowExternalSymlinks: true,
    });
  });

  it('passes prefixBytes through for partial reads', async () => {
    sessionsStore().setActiveSessionId('s1');
    const blob = new Blob(['x'], { type: 'text/plain' });
    apiMock.downloadSessionFile.mockResolvedValue(blob);

    await filesStore().readWorkspaceFileBlob('logs/a.log', { prefixBytes: 4096 });
    expect(apiMock.downloadSessionFile).toHaveBeenCalledWith('s1', 'logs/a.log', {
      prefixBytes: 4096,
      allowExternalSymlinks: true,
    });
  });

  it('streams a draft workspace file through the host download endpoint', async () => {
    workspacesStore().workspaces = [{ id: 'ws1', root: '/repo', name: 'repo', sessionCount: 0 }];
    workspacesStore().storedActiveWorkspaceId = 'ws1';
    const blob = new Blob(['x'], { type: 'image/png' });
    apiMock.downloadHostFile.mockResolvedValue(blob);

    expect(await filesStore().readWorkspaceFileBlob('img/a.png', { prefixBytes: 4096 })).toBe(blob);
    expect(apiMock.downloadHostFile).toHaveBeenCalledWith('/repo/img/a.png', { prefixBytes: 4096 });
    expect(apiMock.downloadSessionFile).not.toHaveBeenCalled();
  });

  it('returns null without an active session or workspace', async () => {
    expect(await filesStore().readWorkspaceFileBlob('img/a.png')).toBeNull();
    expect(apiMock.downloadSessionFile).not.toHaveBeenCalled();
    expect(apiMock.downloadHostFile).not.toHaveBeenCalled();
  });
});

describe('filesStore getFileDownloadUrl', () => {
  it('allows external symlinks in the session download URL', () => {
    sessionsStore().setActiveSessionId('s1');
    apiMock.getFileDownloadUrl.mockReturnValue('https://example.test/download');

    expect(filesStore().getFileDownloadUrl('link/a.png')).toBe(
      'https://example.test/download',
    );
    expect(apiMock.getFileDownloadUrl).toHaveBeenCalledWith('s1', 'link/a.png', {
      allowExternalSymlinks: true,
    });
  });
});

describe('filesStore resolveImageUrl', () => {
  it('passes through remote and data urls untouched', async () => {
    expect(await filesStore().resolveImageUrl('https://x/y.png')).toBe('https://x/y.png');
    expect(await filesStore().resolveImageUrl('data:image/png;base64,AA')).toBe('data:image/png;base64,AA');
    expect(apiMock.readFile).not.toHaveBeenCalled();
  });

  it('reads a workspace-relative image through the session api', async () => {
    sessionsStore().setActiveSessionId('s1');
    apiMock.readFile.mockResolvedValue({
      isBinary: true,
      encoding: 'base64',
      mime: 'image/png',
      content: 'QUJD',
    });

    expect(await filesStore().resolveImageUrl('assets/a.png')).toBe('data:image/png;base64,QUJD');
    expect(apiMock.readFile).toHaveBeenCalledWith('s1', {
      path: 'assets/a.png',
      length: 10_485_760,
      allowExternalSymlinks: true,
    });
  });

  it('returns the source when the read fails or the content is truncated', async () => {
    sessionsStore().setActiveSessionId('s1');
    apiMock.readFile.mockRejectedValue(new Error('boom'));
    expect(await filesStore().resolveImageUrl('assets/a.png')).toBe('assets/a.png');

    apiMock.readFile.mockResolvedValue({ isBinary: true, encoding: 'base64', mime: 'image/png', content: 'QUJD', truncated: true });
    expect(await filesStore().resolveImageUrl('assets/a.png')).toBe('assets/a.png');
  });

  it('maps an absolute path inside the session cwd to a relative read', async () => {
    sessionsStore().setSessions([{ id: 's1', cwd: '/repo/app' } as never]);
    sessionsStore().setActiveSessionId('s1');
    apiMock.readFile.mockResolvedValue({
      isBinary: true,
      encoding: 'base64',
      mime: 'image/png',
      content: 'QUJD',
    });

    expect(await filesStore().resolveImageUrl('/repo/app/assets/a.png')).toBe('data:image/png;base64,QUJD');
    expect(apiMock.readFile).toHaveBeenCalledWith('s1', {
      path: 'assets/a.png',
      length: 10_485_760,
      allowExternalSymlinks: true,
    });
    expect(apiMock.readHostFileContent).not.toHaveBeenCalled();
  });

  it('reads an absolute path outside the session cwd from the host', async () => {
    sessionsStore().setSessions([{ id: 's1', cwd: '/repo/app' } as never]);
    sessionsStore().setActiveSessionId('s1');
    apiMock.readHostFileContent.mockResolvedValue({
      isBinary: true,
      encoding: 'base64',
      mime: 'image/png',
      content: 'QUJD',
    });

    expect(await filesStore().resolveImageUrl('/elsewhere/a.png')).toBe('data:image/png;base64,QUJD');
    expect(apiMock.readHostFileContent).toHaveBeenCalledWith('/elsewhere/a.png');
    expect(apiMock.readFile).not.toHaveBeenCalled();
  });
});

describe('filesStore open/reveal failure reporting', () => {
  it('reports an openFile failure through the hook and returns false', async () => {
    sessionsStore().setActiveSessionId('s1');
    apiMock.openFile.mockRejectedValue(new Error('boom'));
    const failure = vi.fn();
    setFilesHooks({ pushOperationFailure: failure });

    expect(await filesStore().openWorkspaceFile('a.ts', 3)).toBe(false);
    expect(failure).toHaveBeenCalledWith('openFile', expect.anything(), { sessionId: 's1' });
  });

  it('returns true on a successful openFile', async () => {
    sessionsStore().setActiveSessionId('s1');
    apiMock.openFile.mockResolvedValue({});
    expect(await filesStore().openWorkspaceFile('a.ts', 3)).toBe(true);
  });

  it('reports a revealFile failure through the hook and returns false', async () => {
    sessionsStore().setActiveSessionId('s1');
    apiMock.revealFile.mockRejectedValue(new Error('boom'));
    const failure = vi.fn();
    setFilesHooks({ pushOperationFailure: failure });

    expect(await filesStore().revealWorkspaceFile('a.ts')).toBe(false);
    expect(failure).toHaveBeenCalledWith('revealFile', expect.anything(), { sessionId: 's1' });
  });

  it('is a no-op without an active session', async () => {
    expect(await filesStore().openWorkspaceFile('a.ts')).toBe(false);
    expect(await filesStore().revealWorkspaceFile('a.ts')).toBe(false);
    expect(apiMock.openFile).not.toHaveBeenCalled();
    expect(apiMock.revealFile).not.toHaveBeenCalled();
  });
});

describe('filesStore file tree', () => {
  beforeEach(() => {
    filesStore().fileTreeBySession = {};
  });

  it('loads directory children into the per-session cache', async () => {
    const items = [{ path: 'src', name: 'src', kind: 'directory', modifiedAt: '2026-01-01' }];
    apiMock.listDirectory.mockResolvedValue({ items, truncated: false });

    await filesStore().loadFileTreeChildren('s1', '.');

    expect(apiMock.listDirectory).toHaveBeenCalledWith('s1', {
      path: '.',
      showHidden: true,
      allowIgnoredGlobs: ['.tmp', '.tmp/**'],
      allowExternalSymlinks: true,
    });
    expect(filesStore().fileTreeBySession.s1?.children['.']).toEqual(items);
    expect(filesStore().fileTreeBySession.s1?.loading['.']).toBe(false);
    expect(filesStore().fileTreeBySession.s1?.failed['.']).toBe(false);
  });

  it('loads the draft workspace root without a session', async () => {
    const items = [
      { path: 'src', name: 'src', kind: 'directory', modifiedAt: '' },
      { path: 'link', name: 'link', kind: 'symlink', isDirectory: true, modifiedAt: '' },
      { path: 'README.md', name: 'README.md', kind: 'file', modifiedAt: '' },
    ];
    apiMock.listWorkspaceDirectory.mockResolvedValue({ items, truncated: false });

    await filesStore().loadFileTreeChildren('workspace:/repo', '.', { root: '/repo' });

    expect(apiMock.listWorkspaceDirectory).toHaveBeenCalledWith('/repo', {
      path: '.',
      showHidden: true,
      allowIgnoredGlobs: ['.tmp', '.tmp/**'],
      allowExternalSymlinks: true,
    });
    expect(apiMock.suggestFiles).not.toHaveBeenCalled();
    expect(apiMock.listDirectory).not.toHaveBeenCalled();
    expect(filesStore().fileTreeBySession['workspace:/repo']?.children['.']).toEqual(items);
  });

  it('loads an absolute additional draft root and its direct children', async () => {
    const rootItems = [{ path: 'e.txt', name: 'e.txt', kind: 'file', modifiedAt: '' }];
    const childItems = [{ path: 'src/a.ts', name: 'a.ts', kind: 'file', modifiedAt: '' }];
    apiMock.listWorkspaceDirectory
      .mockResolvedValueOnce({ items: rootItems, truncated: false })
      .mockResolvedValueOnce({ items: childItems, truncated: false });

    await filesStore().loadFileTreeChildren('workspace:/extra', '/extra', { root: '/extra' });
    await filesStore().loadFileTreeChildren('workspace:/extra', '/extra/src', { root: '/extra' });

    expect(apiMock.listWorkspaceDirectory).toHaveBeenNthCalledWith(1, '/extra', {
      path: '/extra',
      showHidden: true,
      allowIgnoredGlobs: ['.tmp', '.tmp/**'],
      allowExternalSymlinks: true,
    });
    expect(apiMock.listWorkspaceDirectory).toHaveBeenNthCalledWith(2, '/extra', {
      path: '/extra/src',
      showHidden: true,
      allowIgnoredGlobs: ['.tmp', '.tmp/**'],
      allowExternalSymlinks: true,
    });
    expect(filesStore().fileTreeBySession['workspace:/extra']?.children['/extra']).toEqual(rootItems);
    expect(filesStore().fileTreeBySession['workspace:/extra']?.children['/extra/src']).toEqual(childItems);
  });

  it('uses the registered workspace ID for additional root loads, expansion and refresh', async () => {
    apiMock.listWorkspaceDirectory.mockResolvedValue({ items: [], truncated: false });
    const scope = { workspaceId: 'wm_1', root: '/extra' };

    await filesStore().loadFileTreeChildren('workspace:wm_1', '/extra', scope);
    await filesStore().toggleFileTreeDir('workspace:wm_1', '/extra/src', scope);
    await filesStore().refreshFileTree('workspace:wm_1', scope);

    expect(apiMock.listWorkspaceDirectory.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of apiMock.listWorkspaceDirectory.mock.calls) expect(call[0]).toBe('wm_1');
  });

  it('loads only direct children when expanding a draft workspace directory', async () => {
    const items = [
      { path: 'src/nested', name: 'nested', kind: 'directory', modifiedAt: '' },
      { path: 'src/a.ts', name: 'a.ts', kind: 'file', modifiedAt: '' },
    ];
    apiMock.listWorkspaceDirectory.mockResolvedValue({ items, truncated: false });

    await filesStore().toggleFileTreeDir('workspace:/repo', 'src', { root: '/repo' });

    expect(apiMock.listWorkspaceDirectory).toHaveBeenCalledWith('/repo', {
      path: 'src',
      showHidden: true,
      allowIgnoredGlobs: ['.tmp', '.tmp/**'],
      allowExternalSymlinks: true,
    });
    expect(filesStore().fileTreeBySession['workspace:/repo']?.children.src).toEqual(items);
  });

  it('remembers and validates file tree roots by workspace', () => {
    const trackMock = vi.fn();
    setProductTracker({ track: trackMock });
    const roots = ['/a', '/b'];

    expect(filesStore().resolveFileTreeRoot('w1', roots, '/cwd')).toBe('/a');
    filesStore().selectFileTreeRoot('w1', roots, '/b', '/cwd');
    expect(filesStore().resolveFileTreeRoot('w1', roots, '/cwd')).toBe('/b');
    expect(filesStore().fileTreeRootByWorkspace).toEqual({ w1: '/b' });

    filesStore().selectFileTreeRoot('w1', roots, '/b', '/cwd');
    filesStore().selectFileTreeRoot('w1', roots, '/outside', '/cwd');
    filesStore().selectFileTreeRoot(null, roots, '/a', '/cwd');
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('file_tree_root_switched', {});

    expect(filesStore().resolveFileTreeRoot('w2', roots, '/cwd')).toBe('/a');
    filesStore().selectFileTreeRoot('w2', roots, '/b', '/cwd');
    expect(filesStore().resolveFileTreeRoot('w2', roots, '/cwd')).toBe('/b');
    expect(filesStore().resolveFileTreeRoot('w1', roots, '/cwd')).toBe('/b');
    expect(filesStore().resolveFileTreeRoot('w1', ['/a'], '/cwd')).toBe('/a');
    expect(filesStore().resolveFileTreeRoot('w1', [], '/cwd')).toBe('/cwd');
    expect(trackMock).toHaveBeenCalledTimes(2);
  });

  it('expands a directory lazily and collapses without refetching', async () => {
    apiMock.listDirectory.mockResolvedValue({ items: [], truncated: false });

    await filesStore().toggleFileTreeDir('s1', 'src');
    expect(filesStore().fileTreeBySession.s1?.expanded.src).toBe(true);
    expect(apiMock.listDirectory).toHaveBeenCalledWith('s1', {
      path: 'src',
      showHidden: true,
      allowIgnoredGlobs: ['.tmp', '.tmp/**'],
      allowExternalSymlinks: true,
    });

    await filesStore().toggleFileTreeDir('s1', 'src');
    expect(filesStore().fileTreeBySession.s1?.expanded.src).toBeUndefined();

    await filesStore().toggleFileTreeDir('s1', 'src');
    expect(apiMock.listDirectory).toHaveBeenCalledTimes(1);
  });

  it('expands a directory named like an Object.prototype member', async () => {
    apiMock.listDirectory.mockResolvedValue({ items: [], truncated: false });

    await filesStore().toggleFileTreeDir('s1', 'constructor');

    expect(filesStore().fileTreeBySession.s1?.expanded['constructor']).toBe(true);
    expect(apiMock.listDirectory).toHaveBeenCalledWith('s1', {
      path: 'constructor',
      showHidden: true,
      allowIgnoredGlobs: ['.tmp', '.tmp/**'],
      allowExternalSymlinks: true,
    });
  });

  it('keeps the files-tab preview target per session and clears it with the tree', () => {
    filesStore().setFilePreviewTarget('s1', { path: 'a.ts' });
    expect(filesStore().filePreviewTargetOf('s1')).toEqual({ path: 'a.ts' });
    expect(filesStore().filePreviewTargetOf('s2')).toBeNull();

    filesStore().setFilePreviewTarget('s1', null);
    expect(filesStore().filePreviewTargetOf('s1')).toBeNull();

    filesStore().setFilePreviewTarget('s1', { path: 'b.ts' });
    filesStore().clearSessionFileTree('s1');
    expect(filesStore().filePreviewTargetOf('s1')).toBeNull();
  });

  it('keeps old children and marks failure when a refresh load fails', async () => {
    const items = [{ path: 'a.ts', name: 'a.ts', kind: 'file', modifiedAt: '' }];
    apiMock.listDirectory.mockResolvedValueOnce({ items, truncated: false });
    await filesStore().loadFileTreeChildren('s1', '.');

    apiMock.listDirectory.mockRejectedValueOnce(new Error('boom'));
    await filesStore().refreshFileTree('s1');

    const state = filesStore().fileTreeBySession.s1;
    expect(state?.children['.']).toEqual(items);
    expect(state?.failed['.']).toBe(true);
  });

  it('refreshes the root plus every expanded directory', async () => {
    apiMock.listDirectory.mockResolvedValue({ items: [], truncated: false });
    await filesStore().toggleFileTreeDir('s1', 'src');
    apiMock.listDirectory.mockClear();

    await filesStore().refreshFileTree('s1');

    const paths = apiMock.listDirectory.mock.calls.map((call) => (call[1] as { path: string }).path).sort();
    expect(paths).toEqual(['.', 'src']);
  });

  it('drops the cache of collapsed directories on refresh so re-expanding refetches', async () => {
    apiMock.listDirectory.mockResolvedValue({ items: [], truncated: false });
    await filesStore().loadFileTreeChildren('s1', '.');
    await filesStore().toggleFileTreeDir('s1', 'src');
    await filesStore().toggleFileTreeDir('s1', 'src');
    apiMock.listDirectory.mockClear();

    await filesStore().refreshFileTree('s1');

    expect(filesStore().fileTreeBySession.s1?.children.src).toBeUndefined();
    const paths = apiMock.listDirectory.mock.calls.map((call) => (call[1] as { path: string }).path);
    expect(paths).toEqual(['.']);

    await filesStore().toggleFileTreeDir('s1', 'src');
    expect(apiMock.listDirectory).toHaveBeenCalledWith('s1', {
      path: 'src',
      showHidden: true,
      allowIgnoredGlobs: ['.tmp', '.tmp/**'],
      allowExternalSymlinks: true,
    });
  });

  it('does not issue duplicate loads for the same in-flight directory', async () => {
    let resolveLoad!: (value: unknown) => void;
    apiMock.listDirectory.mockImplementation(() => new Promise((resolve) => { resolveLoad = resolve; }));

    const first = filesStore().loadFileTreeChildren('s1', '.');
    const second = filesStore().loadFileTreeChildren('s1', '.');
    resolveLoad({ items: [], truncated: false });
    await Promise.all([first, second]);

    expect(apiMock.listDirectory).toHaveBeenCalledTimes(1);
  });

  it('clears per-session tree state', async () => {
    apiMock.listDirectory.mockResolvedValue({ items: [], truncated: false });
    await filesStore().loadFileTreeChildren('s1', '.');

    filesStore().clearSessionFileTree('s1');

    expect(filesStore().fileTreeBySession.s1).toBeUndefined();
  });
});

describe('filesStore searchFiles', () => {
  it.each([null, 'missing'])('uses the visible workspace when the saved selection is %s', async (saved) => {
    workspacesStore().workspaces = [{ id: 'project', root: '/project', name: 'project', sessionCount: 0 }];
    workspacesStore().storedActiveWorkspaceId = saved;
    filesStore().resetFilesSearch();
    apiMock.suggestFiles.mockResolvedValue({ items: [{ path: 'notes.txt', name: 'notes.txt', kind: 'file' }] });

    expect(await filesStore().searchFiles('notes')).toEqual([{ path: 'notes.txt', name: 'notes.txt', kind: 'file', matchPositions: undefined }]);
    expect(apiMock.suggestFiles).toHaveBeenCalledWith('project', { query: 'notes', limit: 20 }, { signal: undefined });
  });

  it('searches only an explicitly selected absolute root', async () => {
    apiMock.suggestFilesAtRoots.mockResolvedValue({
      items: [{ path: 'src/notes.txt', name: 'notes.txt', kind: 'file', matchPositions: [4] }],
      truncated: false,
    });

    expect(await filesStore().searchFiles('notes', { root: '/repo/B' })).toEqual([
      { path: 'src/notes.txt', name: 'notes.txt', kind: 'file', matchPositions: [4] },
    ]);
    expect(apiMock.suggestFilesAtRoots).toHaveBeenCalledWith(
      ['/repo/B'],
      { query: 'notes', limit: 20 },
      { signal: undefined },
    );
    expect(apiMock.suggestFiles).not.toHaveBeenCalled();
  });
});
