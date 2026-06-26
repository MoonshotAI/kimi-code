import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { removeStaleFeedbackUploads } from '../../../src/feedback/archive';
import { packageCodebase, scanCodebase } from '../../../src/feedback/codebase';
import { uploadArchive } from '../../../src/feedback/upload';

const execFileAsync = promisify(execFile);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('uploadArchive', () => {
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
      await uploadArchive(
        api,
        {
          path: archivePath,
          size: 5,
          sha256: 'hash',
          fingerprint: 'fingerprint',
          fileCount: 1,
        },
        3,
        { filename: 'repo.zip' },
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
      await uploadArchive(
        api,
        {
          path: archivePath,
          size: 5,
          sha256: 'hash',
          fingerprint: 'fingerprint',
          fileCount: 1,
        },
        3,
        { filename: 'repo.zip' },
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
          () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          },
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
      const upload = uploadArchive(
        api,
        {
          path: archivePath,
          size: 5,
          sha256: 'hash',
          fingerprint: 'fingerprint',
          fileCount: 1,
        },
        3,
        { filename: 'repo.zip', timeoutMs: 25, maxRetries: 0 },
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
      const upload = uploadArchive(
        api,
        {
          path: archivePath,
          size: 5,
          sha256: 'hash',
          fingerprint: 'fingerprint',
          fileCount: 1,
        },
        3,
        { filename: 'repo.zip', timeoutMs: 10_000 },
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

describe('packageCodebase', () => {
  it('rejects empty codebase archives instead of uploading an empty zip', async () => {
    const archivePath = join(tmpdir(), 'feedback-empty-codebase.zip');
    try {
      await expect(
        packageCodebase(
          {
            root: tmpdir(),
            files: [],
            fingerprint: 'empty-codebase',
            usedGitIgnore: false,
          },
          archivePath,
        ),
      ).rejects.toThrow(/empty/i);
      await expect(stat(archivePath)).rejects.toThrow();
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

describe('removeStaleFeedbackUploads', () => {
  it('removes archive dirs older than the cutoff and keeps recent ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feedback-uploads-gc-'));
    try {
      const staleDir = join(root, 'stale');
      const freshDir = join(root, 'fresh');
      await mkdir(staleDir);
      await mkdir(freshDir);
      await writeFile(join(staleDir, 'repo.zip'), 'old');
      await writeFile(join(freshDir, 'repo.zip'), 'new');

      const now = Date.now();
      const twoDaysAgoSec = (now - 2 * 24 * 60 * 60 * 1000) / 1000;
      await utimes(staleDir, twoDaysAgoSec, twoDaysAgoSec);

      await removeStaleFeedbackUploads({ now, dir: root });

      await expect(stat(staleDir)).rejects.toThrow();
      await expect(stat(freshDir)).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is a no-op when the cache dir does not exist', async () => {
    const missing = join(tmpdir(), 'feedback-uploads-gc-missing-' + String(Date.now()));
    await expect(removeStaleFeedbackUploads({ dir: missing })).resolves.toBeUndefined();
  });
});
