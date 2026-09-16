import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  ArtifactLocatorError,
  CdnExecutorArtifactLocator,
  downloadExecutorArtifact,
  releaseTargetKey,
  type ExecutorArtifact,
} from '../src/client/artifactLocator';

const BINARY_BYTES = new TextEncoder().encode('fake-kimi-sea-binary\n');
const BINARY_SHA256 = createHash('sha256').update(BINARY_BYTES).digest('hex');

function manifestBody(version: string, checksum: string = BINARY_SHA256): string {
  return JSON.stringify({
    version,
    tag: `v${version}`,
    platforms: {
      'linux-x64': { filename: 'kimi-code-linux-x64', checksum },
      'darwin-arm64': { filename: 'kimi-code-darwin-arm64', checksum },
    },
  });
}

function fetchReturning(body: string, status = 200): typeof fetch {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
}

const tempDirs: string[] = [];

async function downloadWith(
  artifact: ExecutorArtifact,
  fetchImpl: typeof fetch,
): Promise<{ path: string; sizeBytes: number }> {
  const downloaded = await downloadExecutorArtifact(artifact, { fetchImpl });
  tempDirs.push(dirname(downloaded.path));
  return downloaded;
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('releaseTargetKey', () => {
  it('maps the handshake environment vocabulary to release platform keys', () => {
    expect(releaseTargetKey({ osKind: 'Linux', osArch: 'x64' })).toBe('linux-x64');
    expect(releaseTargetKey({ osKind: 'Linux', osArch: 'arm64' })).toBe('linux-arm64');
    expect(releaseTargetKey({ osKind: 'macOS', osArch: 'x64' })).toBe('darwin-x64');
    expect(releaseTargetKey({ osKind: 'macOS', osArch: 'arm64' })).toBe('darwin-arm64');
  });

  it('rejects non-posix and unknown targets', () => {
    expect(releaseTargetKey({ osKind: 'Windows', osArch: 'x64' })).toBeUndefined();
    expect(releaseTargetKey({ osKind: 'FreeBSD', osArch: 'x64' })).toBeUndefined();
    expect(releaseTargetKey({ osKind: 'Linux', osArch: 'riscv64' })).toBeUndefined();
    expect(releaseTargetKey({ osKind: 'Linux', osArch: 'ia32' })).toBeUndefined();
  });
});

describe('CdnExecutorArtifactLocator', () => {
  const target = { osKind: 'Linux', osArch: 'x64' };

  it('selects the artifact for the target from the release manifest', async () => {
    const fetchImpl = fetchReturning(manifestBody('1.2.3'));
    const locator = new CdnExecutorArtifactLocator({
      cdnBaseUrl: 'https://cdn.example.test/kimi-code/',
      fetchImpl,
    });

    const artifact = await locator.locate(target, '1.2.3');

    expect(artifact).toEqual({
      version: '1.2.3',
      filename: 'kimi-code-linux-x64',
      sha256: BINARY_SHA256,
      url: 'https://cdn.example.test/kimi-code/binaries/1.2.3/kimi-code-linux-x64',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cdn.example.test/kimi-code/binaries/1.2.3/manifest.json',
      expect.anything(),
    );
  });

  it('selects the darwin-arm64 entry for a macOS arm target', async () => {
    const locator = new CdnExecutorArtifactLocator({
      cdnBaseUrl: 'https://cdn.example.test',
      fetchImpl: fetchReturning(manifestBody('1.2.3')),
    });
    const artifact = await locator.locate({ osKind: 'macOS', osArch: 'arm64' }, '1.2.3');
    expect(artifact.filename).toBe('kimi-code-darwin-arm64');
  });

  it('rejects an unsupported target without hitting the network', async () => {
    const fetchImpl = fetchReturning(manifestBody('1.2.3'));
    const locator = new CdnExecutorArtifactLocator({ cdnBaseUrl: 'https://cdn.example.test', fetchImpl });
    await expect(locator.locate({ osKind: 'Windows', osArch: 'x64' }, '1.2.3')).rejects.toThrow(
      ArtifactLocatorError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a manifest served for a different version', async () => {
    const locator = new CdnExecutorArtifactLocator({
      cdnBaseUrl: 'https://cdn.example.test',
      fetchImpl: fetchReturning(manifestBody('9.9.9')),
    });
    await expect(locator.locate(target, '1.2.3')).rejects.toThrow(/served content for 9\.9\.9/);
  });

  it('rejects when the platform is not published in the manifest', async () => {
    const locator = new CdnExecutorArtifactLocator({
      cdnBaseUrl: 'https://cdn.example.test',
      fetchImpl: fetchReturning(manifestBody('1.2.3')),
    });
    await expect(locator.locate({ osKind: 'Linux', osArch: 'arm64' }, '1.2.3')).rejects.toThrow(
      /linux-arm64 is not published/,
    );
  });

  it('rejects on a manifest HTTP error', async () => {
    const locator = new CdnExecutorArtifactLocator({
      cdnBaseUrl: 'https://cdn.example.test',
      fetchImpl: fetchReturning('not found', 404),
    });
    await expect(locator.locate(target, '1.2.3')).rejects.toThrow(/HTTP 404/);
  });

  it('rejects a malformed manifest', async () => {
    const locator = new CdnExecutorArtifactLocator({
      cdnBaseUrl: 'https://cdn.example.test',
      fetchImpl: fetchReturning('"just a string"'),
    });
    await expect(locator.locate(target, '1.2.3')).rejects.toThrow(ArtifactLocatorError);
  });
});

describe('downloadExecutorArtifact', () => {
  const artifact: ExecutorArtifact = {
    version: '1.2.3',
    filename: 'kimi-code-linux-x64',
    url: 'https://cdn.example.test/binaries/1.2.3/kimi-code-linux-x64',
    sha256: BINARY_SHA256,
  };

  it('downloads to a local file and verifies the pinned sha256', async () => {
    const fetchImpl = vi.fn(async () => new Response(BINARY_BYTES, { status: 200 })) as unknown as typeof fetch;
    const downloaded = await downloadWith(artifact, fetchImpl);

    expect(downloaded.sizeBytes).toBe(BINARY_BYTES.length);
    expect(Buffer.compare(await readFile(downloaded.path), Buffer.from(BINARY_BYTES))).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(artifact.url, expect.anything());
  });

  it('rejects a checksum mismatch and names both hashes', async () => {
    const tampered = new TextEncoder().encode('tampered-binary');
    const fetchImpl = vi.fn(async () => new Response(tampered, { status: 200 })) as unknown as typeof fetch;
    const expected = createHash('sha256').update(tampered).digest('hex');

    await expect(downloadWith(artifact, fetchImpl)).rejects.toThrow(
      new RegExp(`checksum mismatch.*${BINARY_SHA256.slice(0, 16)}.*got ${expected.slice(0, 16)}`, 's'),
    );
  });

  it('rejects on a download HTTP error', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    await expect(downloadWith(artifact, fetchImpl)).rejects.toThrow(/HTTP 403/);
  });
});
