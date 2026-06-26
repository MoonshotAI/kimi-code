import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { scanCodebase, packageBundle, packageSessionFiles, uploadPackagedCodebase } from '../../../src/feedback/codebase-upload';

const execFileAsync = promisify(execFile);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('uploadPackagedCodebase', () => {
  it('requests upload parts, PUTs each part, and completes with etags', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'feedback-upload-direct-'));
    const archivePath = join(workRoot, 'repo.zip');
    await writeFile(archivePath, 'hello');

    const fetchMock = vi.fn(
      async () => new Response('', { status: 200, headers: { ETag: '"etag-1"' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = {
      createUploadUrl: vi.fn(async () => ({
        uploadId: 28,
        parts: [{ partNumber: 1, url: 'https://example.test/part1', method: 'PUT', size: 5 }],
      })),
      completeUpload: vi.fn(async () => {}),
    };

    try {
      await uploadPackagedCodebase(
        api,
        {
          path: archivePath,
          size: 5,
          sha256: 'hash',
          fingerprint: 'fingerprint',
          fileCount: 1,
        },
        3,
      );

      expect(api.createUploadUrl).toHaveBeenCalledWith({
        feedbackId: 3,
        filename: 'repo.zip',
        size: 5,
        sha256: 'hash',
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://example.test/part1');
      expect(init.method).toBe('PUT');
      expect(init.body).toBeInstanceOf(ReadableStream);
      expect((init as { duplex?: string }).duplex).toBe('half');
      expect(new Headers(init.headers).get('content-length')).toBe('5');
      // Drain the stream so the underlying file handle is released.
      expect(await new Response(init.body as ReadableStream).text()).toBe('hello');
      expect(api.completeUpload).toHaveBeenCalledWith({
        uploadId: 28,
        parts: [{ partNumber: 1, etag: '"etag-1"' }],
      });
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });

  it('uses the backend-provided part upload method', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'feedback-upload-method-'));
    const archivePath = join(workRoot, 'repo.zip');
    await writeFile(archivePath, 'hello');

    const fetchMock = vi.fn(
      async () => new Response('', { status: 200, headers: { ETag: '"etag-1"' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = {
      createUploadUrl: vi.fn(async () => ({
        uploadId: 28,
        parts: [{ partNumber: 1, url: 'https://example.test/part1', method: 'POST', size: 5 }],
      })),
      completeUpload: vi.fn(async () => {}),
    };

    try {
      await uploadPackagedCodebase(
        api,
        {
          path: archivePath,
          size: 5,
          sha256: 'hash',
          fingerprint: 'fingerprint',
          fileCount: 1,
        },
        3,
      );

      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.method).toBe('POST');
      expect(await new Response(init.body as ReadableStream).text()).toBe('hello');
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });

  it('aborts a stalled part PUT and does not mark upload complete', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'feedback-upload-stalled-'));
    const archivePath = join(workRoot, 'repo.zip');
    await writeFile(archivePath, 'hello');

    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = {
      createUploadUrl: vi.fn(async () => ({
        uploadId: 28,
        parts: [{ partNumber: 1, url: 'https://example.test/part1', method: 'PUT', size: 5 }],
      })),
      completeUpload: vi.fn(async () => {}),
    };

    vi.useFakeTimers();
    try {
      const upload = uploadPackagedCodebase(
        api,
        {
          path: archivePath,
          size: 5,
          sha256: 'hash',
          fingerprint: 'fingerprint',
          fileCount: 1,
        },
        3,
        { timeoutMs: 25, maxRetries: 0 },
      );
      const expectation = expect(upload).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(25);
      await expectation;
      expect(api.completeUpload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await rm(workRoot, { recursive: true, force: true });
    }
  });

  it('retries a failed part and completes once it succeeds', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'feedback-upload-retry-'));
    const archivePath = join(workRoot, 'repo.zip');
    await writeFile(archivePath, 'hello');

    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return new Response('server error', { status: 500 });
      return new Response('', { status: 200, headers: { ETag: '"etag-1"' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = {
      createUploadUrl: vi.fn(async () => ({
        uploadId: 28,
        parts: [{ partNumber: 1, url: 'https://example.test/part1', method: 'PUT', size: 5 }],
      })),
      completeUpload: vi.fn(async () => {}),
    };

    vi.useFakeTimers();
    try {
      const upload = uploadPackagedCodebase(
        api,
        {
          path: archivePath,
          size: 5,
          sha256: 'hash',
          fingerprint: 'fingerprint',
          fileCount: 1,
        },
        3,
        { timeoutMs: 10_000 },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await upload;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(api.completeUpload).toHaveBeenCalledWith({
        uploadId: 28,
        parts: [{ partNumber: 1, etag: '"etag-1"' }],
      });
    } finally {
      vi.useRealTimers();
      await rm(workRoot, { recursive: true, force: true });
    }
  });
});

describe('packageSessionFiles', () => {
  it('recursively packs every file under the session directory', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'feedback-session-'));
    const archivePath = join(tmpdir(), 'feedback-session-test.zip');
    try {
      await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
      await mkdir(join(sessionDir, 'logs'));
      await writeFile(join(sessionDir, 'state.json'), '{}');
      await writeFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), 'events');
      await writeFile(join(sessionDir, 'logs', 'kimi-code.log'), 'logs');

      const archive = await packageSessionFiles(sessionDir, archivePath);
      expect(archive.fileCount).toBe(3);
      expect(archive.size).toBeGreaterThan(0);
      expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
      await rm(archivePath, { force: true });
    }
  });
});

describe('packageBundle', () => {
  it('rejects empty bundles instead of uploading an empty archive', async () => {
    const archivePath = join(tmpdir(), 'feedback-empty-bundle.zip');
    try {
      await expect(packageBundle({}, archivePath)).rejects.toThrow(/empty/i);
    } finally {
      await rm(archivePath, { force: true });
    }
  });
});

describe('scanCodebase filtering', () => {
  it('rejects when the scan signal is already aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feedback-scan-aborted-'));
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(scanCodebase(root, { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips dependency and build directories outside a git work tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feedback-scan-no-git-'));
    try {
      await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
      await mkdir(join(root, 'dist'));
      await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
      await writeFile(join(root, 'dist', 'bundle.js'), 'built\n');
      await writeFile(join(root, 'keep.ts'), 'export const keep = 1;\n');

      const scan = await scanCodebase(root);
      expect(scan.usedGitIgnore).toBe(false);
      expect(scan.files.map((file) => file.path)).toEqual(['keep.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('filters sensitive files even when tracked by git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feedback-scan-git-'));
    try {
      await writeFile(join(root, '.env'), 'SECRET=1\n');
      await writeFile(join(root, '.envrc'), 'export AWS_SECRET_ACCESS_KEY=secret\n');
      await writeFile(join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=secret\n');
      await writeFile(join(root, '.yarnrc.yml'), 'npmAuthToken: secret\n');
      await writeFile(join(root, 'id_rsa'), 'private-key\n');
      await writeFile(join(root, 'app.ts'), 'export const app = 1;\n');
      await execFileAsync('git', ['init'], { cwd: root });
      await execFileAsync('git', ['add', '-A'], { cwd: root });

      const scan = await scanCodebase(root);
      expect(scan.usedGitIgnore).toBe(true);
      const paths = scan.files.map((file) => file.path);
      expect(paths).toContain('app.ts');
      expect(paths).not.toContain('.env');
      expect(paths).not.toContain('.envrc');
      expect(paths).not.toContain('.npmrc');
      expect(paths).not.toContain('.yarnrc.yml');
      expect(paths).not.toContain('id_rsa');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('filters sensitive files by glob outside a git work tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feedback-scan-sensitive-'));
    try {
      await mkdir(join(root, '.ssh'));
      await writeFile(join(root, '.env.production'), 'SECRET=1\n');
      await writeFile(join(root, 'tls.pem'), 'cert\n');
      await writeFile(join(root, '.ssh', 'config'), 'Host *\n');
      await writeFile(join(root, 'keep.ts'), 'export const keep = 1;\n');

      const scan = await scanCodebase(root);
      expect(scan.files.map((file) => file.path)).toEqual(['keep.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips individual files larger than the per-file limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feedback-scan-large-file-'));
    try {
      await writeFile(join(root, 'big.bin'), randomBytes(256));
      await writeFile(join(root, 'small.txt'), 'hello\n');

      const scan = await scanCodebase(root, { limits: { maxFileSize: 128 } });
      expect(scan.files.map((file) => file.path)).toEqual(['small.txt']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips tracked files that were deleted from the working tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feedback-scan-deleted-'));
    try {
      await writeFile(join(root, 'keep.ts'), 'export const keep = 1;\n');
      await writeFile(join(root, 'deleted.ts'), 'export const gone = 1;\n');
      await execFileAsync('git', ['init'], { cwd: root });
      await execFileAsync('git', ['add', '-A'], { cwd: root });
      // Remove only from the working tree; the index still lists it, so
      // `git ls-files` reports a path that no longer exists on disk.
      await rm(join(root, 'deleted.ts'));

      const scan = await scanCodebase(root);
      expect(scan.usedGitIgnore).toBe(true);
      expect(scan.files.map((file) => file.path)).toEqual(['keep.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks exceedsLimit when file count reaches the limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feedback-scan-limit-'));
    try {
      await writeFile(join(root, 'a.txt'), 'a\n');
      await writeFile(join(root, 'b.txt'), 'b\n');
      await writeFile(join(root, 'c.txt'), 'c\n');

      const scan = await scanCodebase(root, { limits: { maxFiles: 2 } });
      expect(scan.files).toHaveLength(2);
      expect(scan.exceedsLimit).toEqual({ reason: 'file-count', limit: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks exceedsLimit when cumulative file size reaches the archive limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feedback-scan-total-size-'));
    try {
      await writeFile(join(root, 'a.txt'), 'a'.repeat(100));
      await writeFile(join(root, 'b.txt'), 'b'.repeat(100));
      await writeFile(join(root, 'c.txt'), 'c'.repeat(100));

      // 250 bytes fits any two files (200) but not the third (300).
      const scan = await scanCodebase(root, { limits: { maxArchiveSize: 250 } });
      expect(scan.files).toHaveLength(2);
      expect(scan.exceedsLimit).toEqual({ reason: 'total-size', limit: 250 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
