/**
 * Covers: rg-locator (ripgrep hybrid binary resolution).
 *
 * Pure-lookup pins (no real CDN download):
 *   - `findExistingRg` returns undefined when PATH + share-bin are both empty
 *   - Resolves from `<shareDir>/bin/rg` when that binary exists
 *   - Prefers system PATH over share-dir cache when both are available
 *   - `rgUnavailableMessage` surfaces the underlying cause + install hints
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { extract as extractTar } from 'tar';
import { ZipFile } from 'yazl';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  detectTarget,
  ensureRgPath,
  extractRgFromZip,
  findExistingRg,
  rgUnavailableMessage,
  verifyArchiveChecksum,
  type RgProbe,
} from '#/os/backends/node-local/tools/rgLocator';

vi.mock('tar', () => ({ extract: vi.fn() }));

function probeWith(
  resolveExitCode: (args: readonly string[]) => number,
): RgProbe & { exec: ReturnType<typeof vi.fn> } {
  return {
    exec: vi.fn(async (args: readonly string[]) => ({ exitCode: resolveExitCode(args) })),
  };
}

function noRgProbe(): RgProbe & { exec: ReturnType<typeof vi.fn> } {
  return probeWith(() => -1);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('findExistingRg', () => {
  let fakeShare: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    fakeShare = join(tmpdir(), `kimi-rg-${String(Date.now())}-${String(Math.random()).slice(2)}`);
    mkdirSync(join(fakeShare, 'bin'), { recursive: true });
    savedPath = process.env['PATH'];
    process.env['PATH'] = '';
  });
  afterEach(() => {
    rmSync(fakeShare, { recursive: true, force: true });
    if (savedPath === undefined) {
      delete process.env['PATH'];
    } else {
      process.env['PATH'] = savedPath;
    }
  });

  it('returns undefined when no rg anywhere', async () => {
    const result = await findExistingRg(noRgProbe(), fakeShare);
    expect(result).toBeUndefined();
  });

  it('resolves from share-dir when cached', async () => {
    const cached = join(fakeShare, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
    writeFileSync(cached, 'fake rg');
    const probe = noRgProbe();
    const result = await findExistingRg(probe, fakeShare);

    expect(result).toEqual({ path: cached, source: 'share-bin-cached' });
    expect(probe.exec).not.toHaveBeenCalled();
  });

  it('prefers system PATH over share-dir when both are available', async () => {
    const binDir = join(fakeShare, 'path-bin');
    mkdirSync(binDir, { recursive: true });
    const systemRg = join(binDir, process.platform === 'win32' ? 'rg.exe' : 'rg');
    const cached = join(fakeShare, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
    writeFileSync(systemRg, 'fake system rg');
    writeFileSync(cached, 'fake cached rg');
    process.env['PATH'] = binDir;
    const probe = noRgProbe();
    const result = await findExistingRg(probe, fakeShare);

    expect(result).toEqual({ path: systemRg, source: 'system-path' });
    expect(probe.exec).not.toHaveBeenCalled();
  });
});

describe('detectTarget', () => {
  let savedArch: string;
  let savedPlatform: string;
  beforeEach(() => {
    savedArch = process.arch;
    savedPlatform = process.platform;
  });
  afterEach(() => {
    Object.defineProperty(process, 'arch', { value: savedArch });
    Object.defineProperty(process, 'platform', { value: savedPlatform });
  });

  function setPlatform(arch: string, platform: string): void {
    Object.defineProperty(process, 'arch', { value: arch });
    Object.defineProperty(process, 'platform', { value: platform });
  }

  it('darwin arm64 -> aarch64-apple-darwin', () => {
    setPlatform('arm64', 'darwin');
    expect(detectTarget()).toBe('aarch64-apple-darwin');
  });
  it('darwin x64 -> x86_64-apple-darwin', () => {
    setPlatform('x64', 'darwin');
    expect(detectTarget()).toBe('x86_64-apple-darwin');
  });
  it('linux x64 -> x86_64-unknown-linux-musl', () => {
    setPlatform('x64', 'linux');
    expect(detectTarget()).toBe('x86_64-unknown-linux-musl');
  });
  it('linux arm64 -> aarch64-unknown-linux-gnu', () => {
    setPlatform('arm64', 'linux');
    expect(detectTarget()).toBe('aarch64-unknown-linux-gnu');
  });
  it('win32 x64 -> x86_64-pc-windows-msvc', () => {
    setPlatform('x64', 'win32');
    expect(detectTarget()).toBe('x86_64-pc-windows-msvc');
  });
  it('unsupported arch -> undefined', () => {
    setPlatform('mips', 'linux');
    expect(detectTarget()).toBeUndefined();
  });
});

describe('rgUnavailableMessage', () => {
  it('surfaces the underlying cause and install hints', () => {
    const msg = rgUnavailableMessage(new Error('fetch failed'));
    expect(msg).toContain('automatic bootstrap failed');
    expect(msg).toContain('fetch failed');
    expect(msg).toContain('brew install ripgrep');
    expect(msg).toContain('https://github.com/BurntSushi/ripgrep');
  });

  it('handles non-Error causes (string, unknown)', () => {
    const a = rgUnavailableMessage('boom');
    expect(a).toContain('boom');
    const b = rgUnavailableMessage(42);
    expect(b).toContain('unknown error');
  });
});

describe('verifyArchiveChecksum', () => {
  let fakeDir: string;
  beforeEach(() => {
    fakeDir = join(tmpdir(), `kimi-rg-sha-${String(Date.now())}-${String(Math.random()).slice(2)}`);
    mkdirSync(fakeDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(fakeDir, { recursive: true, force: true });
  });

  it('accepts a file whose SHA-256 matches the expected digest', async () => {
    const archivePath = join(fakeDir, 'archive.tar.gz');
    const payload = Buffer.from('trusted archive bytes', 'utf8');
    writeFileSync(archivePath, payload);
    const expectedSha256 = createHash('sha256').update(payload).digest('hex');

    await expect(
      verifyArchiveChecksum(archivePath, 'archive.tar.gz', expectedSha256),
    ).resolves.toBeUndefined();
  });

  it('rejects a file whose SHA-256 differs from the expected digest', async () => {
    const archivePath = join(fakeDir, 'archive.tar.gz');
    writeFileSync(archivePath, 'tampered archive bytes');

    await expect(
      verifyArchiveChecksum(archivePath, 'archive.tar.gz', '0'.repeat(64)),
    ).rejects.toThrow(/checksum mismatch/);
  });
});

describe('ensureRgPath download branch', () => {
  let fakeShare: string;
  let savedFetch: typeof globalThis.fetch | undefined;
  let savedPath: string | undefined;
  beforeEach(() => {
    fakeShare = join(
      tmpdir(),
      `kimi-rg-dl-${String(Date.now())}-${String(Math.random()).slice(2)}`,
    );
    mkdirSync(join(fakeShare, 'bin'), { recursive: true });
    savedFetch = globalThis.fetch;
    savedPath = process.env['PATH'];
    process.env['PATH'] = '';
  });
  afterEach(() => {
    rmSync(fakeShare, { recursive: true, force: true });
    if (savedFetch === undefined) {
      delete (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    } else {
      globalThis.fetch = savedFetch;
    }
    if (savedPath === undefined) {
      delete process.env['PATH'];
    } else {
      process.env['PATH'] = savedPath;
    }
    vi.restoreAllMocks();
  });

  it('does not bootstrap when allowCachedFallback is false', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(ensureRgPath(noRgProbe(), { shareDir: fakeShare })).rejects.toThrow(/on PATH/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a network error when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network unreachable')) as typeof fetch;

    await expect(
      ensureRgPath(noRgProbe(), { shareDir: fakeShare, allowCachedFallback: true }),
    ).rejects.toThrow(/network unreachable/);
  });

  it('does not start bootstrap work when the caller is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      ensureRgPath(noRgProbe(), {
        shareDir: fakeShare,
        signal: controller.signal,
        allowCachedFallback: true,
      }),
    ).rejects.toHaveProperty('name', 'AbortError');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not run probe subprocesses while lookup misses', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network unreachable')) as typeof fetch;
    const probe = noRgProbe();

    await expect(
      ensureRgPath(probe, { shareDir: fakeShare, allowCachedFallback: true }),
    ).rejects.toThrow(/network unreachable/);

    expect(probe.exec).not.toHaveBeenCalled();
  });

  it('aborts the current caller wait while shared bootstrap work continues', async () => {
    const controller = new AbortController();
    const fetchResponse = deferred<{
      readonly ok: false;
      readonly status: number;
      readonly statusText: string;
      readonly body: null;
    }>();
    globalThis.fetch = vi.fn(() => fetchResponse.promise) as unknown as typeof fetch;

    const resultPromise = ensureRgPath(noRgProbe(), {
      shareDir: fakeShare,
      signal: controller.signal,
      allowCachedFallback: true,
    });

    await vi.waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
    controller.abort();
    await expect(resultPromise).rejects.toHaveProperty('name', 'AbortError');

    fetchResponse.resolve({ ok: false, status: 499, statusText: 'Client Closed', body: null });
    await expect(
      ensureRgPath(noRgProbe(), { shareDir: fakeShare, allowCachedFallback: true }),
    ).rejects.toThrow(/HTTP 499 Client Closed/);
  });

  it('surfaces HTTP failure (non-2xx response) with status + statusText', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      body: null,
    }) as unknown as typeof fetch;

    await expect(
      ensureRgPath(noRgProbe(), { shareDir: fakeShare, allowCachedFallback: true }),
    ).rejects.toThrow(/HTTP 404 Not Found/);
  });

  it('fetches ripgrep over HTTPS', async () => {
    const body = bodyFromBuffer(Buffer.from('not a real archive', 'utf8'));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      ensureRgPath(noRgProbe(), { shareDir: fakeShare, allowCachedFallback: true }),
    ).rejects.toThrow();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(new URL(url).protocol).toBe('https:');
  });

  it('rejects archives that do not match the pinned SHA-256 before extraction', async () => {
    const tarMock = vi.mocked(extractTar);
    tarMock.mockClear();
    const body = bodyFromBuffer(Buffer.from('tampered archive', 'utf8'));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body,
    }) as unknown as typeof fetch;

    await expect(
      ensureRgPath(noRgProbe(), { shareDir: fakeShare, allowCachedFallback: true }),
    ).rejects.toThrow(/checksum/i);

    expect(tarMock).not.toHaveBeenCalled();
    expect(existsSync(join(fakeShare, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'))).toBe(
      false,
    );
  });
});

function buildFixtureZip(entries: Array<{ name: string; content: Buffer }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    for (const { name, content } of entries) {
      zip.addBuffer(content, name);
    }
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => {
      chunks.push(c);
    });
    zip.outputStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    zip.outputStream.on('error', reject);
  });
}

function bodyFromBuffer(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

describe('ensureRgPath Windows download branch', () => {
  let fakeShare: string;
  let savedFetch: typeof globalThis.fetch | undefined;
  let savedArch: string;
  let savedPlatform: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    fakeShare = join(
      tmpdir(),
      `kimi-rg-win-${String(Date.now())}-${String(Math.random()).slice(2)}`,
    );
    mkdirSync(join(fakeShare, 'bin'), { recursive: true });
    savedFetch = globalThis.fetch;
    savedPath = process.env['PATH'];
    process.env['PATH'] = '';
    savedArch = process.arch;
    savedPlatform = process.platform;
    Object.defineProperty(process, 'arch', { value: 'x64' });
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });
  afterEach(() => {
    rmSync(fakeShare, { recursive: true, force: true });
    if (savedFetch === undefined) {
      delete (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    } else {
      globalThis.fetch = savedFetch;
    }
    if (savedPath === undefined) {
      delete process.env['PATH'];
    } else {
      process.env['PATH'] = savedPath;
    }
    Object.defineProperty(process, 'arch', { value: savedArch });
    Object.defineProperty(process, 'platform', { value: savedPlatform });
    vi.restoreAllMocks();
  });

  it('fetches the .zip URL (not .tar.gz) on Windows target', async () => {
    const zipBuf = await buildFixtureZip([
      {
        name: 'ripgrep-15.0.0-x86_64-pc-windows-msvc/rg.exe',
        content: Buffer.from('MZfake-pe-bytes', 'utf8'),
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: bodyFromBuffer(zipBuf),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      ensureRgPath(noRgProbe(), { shareDir: fakeShare, allowCachedFallback: true }),
    ).rejects.toThrow(/checksum mismatch/);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/ripgrep-15\.0\.0-x86_64-pc-windows-msvc\.zip$/);
  });

  it('extracts rg.exe into <shareDir>/bin/rg.exe', async () => {
    const payload = Buffer.from('MZfake-pe-bytes-extracted', 'utf8');
    const zipBuf = await buildFixtureZip([
      {
        name: 'ripgrep-15.0.0-x86_64-pc-windows-msvc/rg.exe',
        content: payload,
      },
    ]);

    const archivePath = join(fakeShare, 'fixture.zip');
    const installed = join(fakeShare, 'bin', 'rg.exe');
    writeFileSync(archivePath, zipBuf);

    await extractRgFromZip(archivePath, installed);

    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed)).toEqual(payload);
  });

  it('throws with "CDN content may have changed" when the zip omits rg.exe', async () => {
    const zipBuf = await buildFixtureZip([{ name: 'README.md', content: Buffer.from('readme') }]);
    const archivePath = join(fakeShare, 'fixture.zip');
    const installed = join(fakeShare, 'bin', 'rg.exe');
    writeFileSync(archivePath, zipBuf);

    await expect(extractRgFromZip(archivePath, installed)).rejects.toThrow(
      /CDN content may have changed/,
    );
  });

  it('surfaces HTTP failure on Windows with status + statusText', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      body: null,
    }) as unknown as typeof fetch;

    await expect(
      ensureRgPath(noRgProbe(), { shareDir: fakeShare, allowCachedFallback: true }),
    ).rejects.toThrow(/HTTP 502 Bad Gateway/);
  });
});
