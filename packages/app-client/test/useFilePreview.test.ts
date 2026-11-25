import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { DaemonApiError } from '@moonshot-ai/app-core/api';
import { useFilePreview, type FilePreviewClient } from '../src/composables/useFilePreview';

function makeClient(overrides: Partial<FilePreviewClient>): FilePreviewClient {
  return {
    status: ref({ cwd: '/ws/a' }),
    getFileDownloadUrl: () => null,
    getFsHome: vi.fn(async () => ({ home: '', recentRoots: [] })),
    readHostFileContent: vi.fn(),
    readFileContent: vi.fn(),
    readWorkspaceFileBlob: vi.fn(),
    openWorkspaceFile: vi.fn(),
    revealWorkspaceFile: vi.fn(),
    ...overrides,
  };
}

const t = (key: string, params?: Record<string, unknown>) => (params?.path ? `${key} ${params.path}` : key);

function notFoundError(): DaemonApiError {
  return new DaemonApiError({ code: 40409, msg: 'not found', requestId: 'r' });
}

function tooLargeError(): DaemonApiError {
  return new DaemonApiError({ code: 41302, msg: 'file too large: logs/huge.log (26214400 bytes > 10485760)', requestId: 'r' });
}

function textBlob(text: string, type = 'text/plain'): Blob {
  return new Blob([text], { type });
}

describe('useFilePreview not-found errors', () => {
  it('reports the attempted workspace path when a relative path is missing', async () => {
    const client = makeClient({ readFileContent: vi.fn().mockRejectedValue(notFoundError()) });
    const preview = useFilePreview({ client, t });
    await preview.openFilePreview({ path: 'package.json' });
    expect(client.readFileContent).toHaveBeenCalledWith('package.json');
    expect(preview.previewError.value).toBe('filePreview.errors.notFoundInWorkspace /ws/a/package.json');
  });

  it('falls back to the generic message when cwd is empty', async () => {
    const client = makeClient({ status: ref({ cwd: '' }), readFileContent: vi.fn().mockRejectedValue(notFoundError()) });
    const preview = useFilePreview({ client, t });
    await preview.openFilePreview({ path: 'package.json' });
    expect(preview.previewError.value).toBe('filePreview.errors.notFound');
  });

  it('keeps the generic message for host-read misses outside the workspace', async () => {
    const client = makeClient({ readHostFileContent: vi.fn().mockRejectedValue(notFoundError()) });
    const preview = useFilePreview({ client, t });
    await preview.openFilePreview({ path: '/other/proj/package.json' });
    expect(client.readHostFileContent).toHaveBeenCalledWith('/other/proj/package.json');
    expect(preview.previewError.value).toBe('filePreview.errors.notFound');
  });

  it('preserves the assumed flag on the preview target', async () => {
    const client = makeClient({
      readFileContent: vi.fn().mockResolvedValue({
        path: 'package.json',
        content: '{}',
        encoding: 'utf-8',
        mime: 'application/json',
        isBinary: false,
        size: 2,
      }),
    });
    const preview = useFilePreview({ client, t });
    await preview.openFilePreview({ path: 'package.json', assumed: true });
    expect(preview.previewTarget.value?.assumed).toBe(true);
    expect(preview.previewError.value).toBeNull();
  });
});

describe('useFilePreview tilde paths', () => {
  it('expands the home directory before reading a file outside the workspace', async () => {
    const getFsHome = vi.fn(async () => ({ home: '/Users/test', recentRoots: [] }));
    const readHostFileContent = vi.fn(async (path: string) => ({
      path,
      content: '# Rules',
      encoding: 'utf-8' as const,
      mime: 'text/markdown',
      isBinary: false,
      size: 7,
    }));
    const client = makeClient({ getFsHome, readHostFileContent });
    const preview = useFilePreview({ client, t });

    await preview.openFilePreview({ path: '~/agent-workspace/rules/common.md' });

    expect(getFsHome).toHaveBeenCalledOnce();
    expect(readHostFileContent).toHaveBeenCalledWith('/Users/test/agent-workspace/rules/common.md');
    expect(preview.previewError.value).toBeNull();
    expect(preview.previewFile.value?.path).toBe('/Users/test/agent-workspace/rules/common.md');
    expect(preview.previewAbsolutePath.value).toBe('/Users/test/agent-workspace/rules/common.md');
  });

  it('normalizes an expanded Windows home directory', async () => {
    const getFsHome = vi.fn(async () => ({ home: 'C:\\Users\\test', recentRoots: [] }));
    const readHostFileContent = vi.fn(async (path: string) => ({
      path,
      content: '# Rules',
      encoding: 'utf-8' as const,
      mime: 'text/markdown',
      isBinary: false,
      size: 7,
    }));
    const client = makeClient({ status: ref({ cwd: 'C:\\work' }), getFsHome, readHostFileContent });
    const preview = useFilePreview({ client, t });

    await preview.openFilePreview({ path: '~/agent-workspace/rules/common.md' });

    expect(readHostFileContent).toHaveBeenCalledWith('C:/Users/test/agent-workspace/rules/common.md');
    expect(preview.previewError.value).toBeNull();
    expect(preview.previewAbsolutePath.value).toBe('C:/Users/test/agent-workspace/rules/common.md');
  });
});

describe('useFilePreview streamed media', () => {
  it('streams raster images through a blob object URL instead of fs:read', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock-image');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
    const client = makeClient({ readWorkspaceFileBlob: vi.fn().mockResolvedValue(blob) });
    const preview = useFilePreview({ client, t });
    await preview.openFilePreview({ path: 'poster/page-1.png' });
    expect(client.readWorkspaceFileBlob).toHaveBeenCalledWith('poster/page-1.png');
    expect(client.readFileContent).not.toHaveBeenCalled();
    expect(preview.previewFile.value).toMatchObject({
      path: 'poster/page-1.png',
      mime: 'image/png',
      isBinary: true,
      size: blob.size,
    });
    expect(preview.previewMediaUrl.value).toBe('blob:mock-image');
    expect(preview.previewError.value).toBeNull();
    vi.unstubAllGlobals();
  });

  it('streams PDFs through a blob object URL', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock-pdf');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    const blob = new Blob(['%PDF-1.7'], { type: 'application/pdf' });
    const client = makeClient({ readWorkspaceFileBlob: vi.fn().mockResolvedValue(blob) });
    const preview = useFilePreview({ client, t });
    await preview.openFilePreview({ path: 'docs/report.pdf' });
    expect(client.readFileContent).not.toHaveBeenCalled();
    expect(preview.previewFile.value?.mime).toBe('application/pdf');
    expect(preview.previewMediaUrl.value).toBe('blob:mock-pdf');
    vi.unstubAllGlobals();
  });

  it('revokes the previous object URL when the preview resets', async () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL });
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    const client = makeClient({ readWorkspaceFileBlob: vi.fn().mockResolvedValue(blob) });
    const preview = useFilePreview({ client, t });
    await preview.openFilePreview({ path: 'a.png' });
    preview.closeFilePreview();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    expect(preview.previewMediaUrl.value).toBeNull();
    vi.unstubAllGlobals();
  });

  it('never materializes an object URL when the scope dies mid-stream', async () => {
    const createObjectURL = vi.fn(() => 'blob:late');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    const { effectScope } = await import('vue');
    let resolveBlob!: (blob: Blob) => void;
    const client = makeClient({
      readWorkspaceFileBlob: vi.fn().mockImplementation(
        () => new Promise<Blob>((resolve) => { resolveBlob = resolve; }),
      ),
    });
    const scope = effectScope();
    const preview = scope.run(() => useFilePreview({ client, t }))!;
    const pending = preview.openFilePreview({ path: 'a.png' });
    scope.stop();
    resolveBlob(new Blob([new Uint8Array([1])], { type: 'image/png' }));
    await pending;
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(preview.previewMediaUrl.value).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('useFilePreview oversized text files', () => {
  it('shows the leading slice with a truncated flag when fs:read rejects with FS_TOO_LARGE', async () => {
    const client = makeClient({
      readFileContent: vi.fn().mockRejectedValue(tooLargeError()),
      readWorkspaceFileBlob: vi.fn().mockResolvedValue(textBlob('x'.repeat(2048))),
    });
    const preview = useFilePreview({ client, t });
    await preview.openFilePreview({ path: 'logs/huge.log' });
    expect(client.readWorkspaceFileBlob).toHaveBeenCalledWith('logs/huge.log', { prefixBytes: 10_485_760 });
    expect(preview.previewError.value).toBeNull();
    expect(preview.previewFile.value).toMatchObject({
      path: 'logs/huge.log',
      encoding: 'utf-8',
      truncated: true,
      size: 26214400,
    });
    expect(preview.previewFile.value?.content).toHaveLength(2048);
  });

  it('falls back to the blob size when the error message carries no total', async () => {
    const client = makeClient({
      readFileContent: vi.fn().mockRejectedValue(new DaemonApiError({ code: 41302, msg: 'too large', requestId: 'r' })),
      readWorkspaceFileBlob: vi.fn().mockResolvedValue(textBlob('x'.repeat(2048))),
    });
    const preview = useFilePreview({ client, t });
    await preview.openFilePreview({ path: 'logs/huge.log' });
    expect(preview.previewFile.value?.size).toBe(2048);
  });

  it('slices the stream down to the preview byte cap', async () => {
    const oversized = 'y'.repeat(11 * 1024 * 1024);
    const client = makeClient({
      readFileContent: vi.fn().mockRejectedValue(tooLargeError()),
      readWorkspaceFileBlob: vi.fn().mockResolvedValue(textBlob(oversized)),
    });
    const preview = useFilePreview({ client, t });
    await preview.openFilePreview({ path: 'logs/huge.log' });
    expect(preview.previewFile.value?.truncated).toBe(true);
    expect(preview.previewFile.value?.content.length).toBeLessThanOrEqual(10_485_760);
  });

  it('reports tooLarge instead of a preview when the stream is octet-stream without NUL bytes', async () => {
    const binary = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'application/octet-stream' });
    const client = makeClient({
      readFileContent: vi.fn().mockRejectedValue(tooLargeError()),
      readWorkspaceFileBlob: vi.fn().mockResolvedValue(binary),
    });
    const preview = useFilePreview({ client, t });
    await preview.openFilePreview({ path: 'data/huge.dat' });
    expect(preview.previewFile.value).toBeNull();
    expect(preview.previewError.value).toBe('filePreview.errors.tooLarge');
  });

  it('reports tooLarge instead of a preview when the oversized file is binary', async () => {
    const binary = new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'text/plain' });
    const client = makeClient({
      readFileContent: vi.fn().mockRejectedValue(tooLargeError()),
      readWorkspaceFileBlob: vi.fn().mockResolvedValue(binary),
    });
    const preview = useFilePreview({ client, t });
    await preview.openFilePreview({ path: 'data/huge.bin' });
    expect(preview.previewFile.value).toBeNull();
    expect(preview.previewError.value).toBe('filePreview.errors.tooLarge');
  });

  it('revokes the object URL when the owning effect scope is disposed', async () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:scoped'), revokeObjectURL });
    const { effectScope } = await import('vue');
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    const client = makeClient({ readWorkspaceFileBlob: vi.fn().mockResolvedValue(blob) });
    const scope = effectScope();
    const preview = scope.run(() => useFilePreview({ client, t }))!;
    await preview.openFilePreview({ path: 'a.png' });
    expect(preview.previewMediaUrl.value).toBe('blob:scoped');
    scope.stop();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:scoped');
    expect(preview.previewMediaUrl.value).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('useFilePreview additional workspace roots', () => {
  it('uses the selected root for text and external actions and keeps it across root changes', async () => {
    const readFileContent = vi.fn().mockResolvedValue({
      path: 'e.txt',
      content: 'content',
      encoding: 'utf-8',
      mime: 'text/plain',
      isBinary: false,
      size: 7,
    });
    const getFileDownloadUrl = vi.fn(() => 'blob:download');
    const openWorkspaceFile = vi.fn();
    const revealWorkspaceFile = vi.fn();
    const readHostFileContent = vi.fn();
    const client = makeClient({
      readFileContent,
      getFileDownloadUrl,
      openWorkspaceFile,
      revealWorkspaceFile,
      readHostFileContent,
    });
    const root = ref('/ws/b');
    const preview = useFilePreview({ client, t, root });

    await preview.openFilePreview({ path: '/ws/b/e.txt' });

    expect(readFileContent).toHaveBeenCalledWith('/ws/b/e.txt');
    expect(readHostFileContent).not.toHaveBeenCalled();
    expect(preview.previewNormalizedPath.value).toBe('e.txt');
    expect(preview.previewAbsolutePath.value).toBe('/ws/b/e.txt');
    expect(preview.previewExternalActions.value).toBe(true);
    expect(preview.previewDownloadUrl.value).toBe('blob:download');
    expect(getFileDownloadUrl).toHaveBeenCalledWith('/ws/b/e.txt');

    preview.openPreviewInEditor();
    preview.revealPreviewFile();
    expect(openWorkspaceFile).toHaveBeenCalledWith('/ws/b/e.txt', undefined);
    expect(revealWorkspaceFile).toHaveBeenCalledWith('/ws/b/e.txt');

    root.value = '/ws/c';
    await preview.refreshFilePreview();
    expect(readFileContent).toHaveBeenNthCalledWith(1, '/ws/b/e.txt');
    expect(readFileContent).toHaveBeenNthCalledWith(2, '/ws/b/e.txt');
    expect(preview.previewAbsolutePath.value).toBe('/ws/b/e.txt');
  });

  it('uses the selected root for streamed media', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:extra'), revokeObjectURL: vi.fn() });
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    const readWorkspaceFileBlob = vi.fn().mockResolvedValue(blob);
    const readFileContent = vi.fn();
    const client = makeClient({ readWorkspaceFileBlob, readFileContent });
    const preview = useFilePreview({ client, t, root: ref('/ws/b') });

    await preview.openFilePreview({ path: '/ws/b/image.png' });

    expect(readWorkspaceFileBlob).toHaveBeenCalledWith('/ws/b/image.png');
    expect(readFileContent).not.toHaveBeenCalled();
    expect(preview.previewNormalizedPath.value).toBe('image.png');
    expect(preview.previewExternalActions.value).toBe(true);
    expect(preview.previewMediaUrl.value).toBe('blob:extra');
    vi.unstubAllGlobals();
  });

  it('builds native absolute preview paths for Windows roots', async () => {
    for (const [cwd, expected] of [
      ['C:\\work', 'C:\\work\\notes.md'],
      ['C:\\work\\', 'C:\\work\\notes.md'],
      ['\\\\server\\share', '\\\\server\\share\\notes.md'],
    ]) {
      const client = makeClient({
        status: ref({ cwd }),
        readFileContent: vi.fn().mockResolvedValue({ path: 'notes.md', content: '# Notes', encoding: 'utf-8', mime: 'text/markdown', isBinary: false, size: 7 }),
      });
      const preview = useFilePreview({ client, t });
      await preview.openFilePreview({ path: 'notes.md' });
      expect(preview.previewAbsolutePath.value).toBe(expected);
    }
  });
});
