import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { ContentPart } from '#/app/llmProtocol';
import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import {
  AgentBlobServiceImpl,
  BLOBREF_PROTOCOL,
  IAgentBlobService,
  MISSING_MEDIA_PLACEHOLDER,
} from '#/agent/blob';
import { IBootstrapService } from '#/app/bootstrap';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { BlobStoreService } from '#/persistence/backends/node-fs/blobStoreService';

const cleanups: string[] = [];
const disposables: DisposableStore[] = [];

afterEach(async () => {
  for (const store of disposables.splice(0)) {
    store.dispose();
  }
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function imagePart(url: string): ContentPart {
  return { type: 'image_url', imageUrl: { url } } as ContentPart;
}

function videoPart(url: string): ContentPart {
  return { type: 'video_url', videoUrl: { url } } as ContentPart;
}

function firstImageUrl(parts: readonly ContentPart[]): string {
  return (parts[0] as unknown as { imageUrl: { url: string } }).imageUrl.url;
}

function secondVideoUrl(parts: readonly ContentPart[]): string {
  return (parts[1] as unknown as { videoUrl: { url: string } }).videoUrl.url;
}

function imageUrlObject(part: ContentPart): { url: string } {
  return (part as unknown as { imageUrl: { url: string } }).imageUrl;
}

async function makeHomeDir(): Promise<{ homeDir: string; blobsDir: string }> {
  const homeDir = join(tmpdir(), `blobref-test-${randomBytes(6).toString('hex')}`);
  await mkdir(homeDir, { recursive: true });
  cleanups.push(homeDir);
  return { homeDir, blobsDir: join(homeDir, 'blobs') };
}

function createStore(
  homeDir: string,
  ctor: typeof AgentBlobServiceImpl = AgentBlobServiceImpl,
): IAgentBlobService {
  const disposable = new DisposableStore();
  disposables.push(disposable);

  const ix = disposable.add(new TestInstantiationService());
  ix.set(IFileSystemStorageService, new FileStorageService(homeDir));
  ix.set(IBlobStore, new SyncDescriptor(BlobStoreService, []));
  ix.set(IBootstrapService, { homeDir } as unknown as IBootstrapService);
  ix.set(
    IAgentScopeContext,
    makeAgentScopeContext({ agentId: 'test', agentScope: '' }),
  );
  ix.set(IAgentBlobService, new SyncDescriptor(ctor, [{}]));
  return ix.get(IAgentBlobService);
}

async function makeStore(): Promise<{ store: IAgentBlobService; blobsDir: string }> {
  const { homeDir, blobsDir } = await makeHomeDir();
  return {
    store: createStore(homeDir),
    blobsDir,
  };
}

class TwoBlobCacheStoreService extends AgentBlobServiceImpl {
  protected override get maxCacheSize(): number {
    return 8_000;
  }
}

class OneBlobCacheStoreService extends AgentBlobServiceImpl {
  protected override get maxCacheSize(): number {
    return 4_000;
  }
}

describe('blobref', () => {
  it('offloads large data URIs and replaces with blobref', async () => {
    const { store, blobsDir } = await makeStore();
    const payload = 'A'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;

    const offloaded = await store.offloadParts([imagePart(dataUri)]);
    const url = firstImageUrl(offloaded);

    expect(store.isBlobRef(url)).toBe(true);
    expect(url.startsWith(BLOBREF_PROTOCOL)).toBe(true);
    expect(url.startsWith('blobref:image/png;')).toBe(true);

    const files = await readdir(blobsDir);
    expect(files).toHaveLength(1);
    expect((await readFile(join(blobsDir, files[0]!))).toString('base64')).toBe(payload);
  });

  it('does not mutate the input array or content parts', async () => {
    const { store } = await makeStore();
    const payload = 'M'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;
    const innerImageUrl = { url: dataUri };
    const part = { type: 'image_url', imageUrl: innerImageUrl } as unknown as ContentPart;
    const parts = [part];

    const offloaded = await store.offloadParts(parts);

    expect(parts[0]).toBe(part);
    expect(imageUrlObject(part)).toBe(innerImageUrl);
    expect(innerImageUrl.url).toBe(dataUri);

    expect(offloaded).not.toBe(parts);
    expect(offloaded[0]).not.toBe(part);
    expect(imageUrlObject(offloaded[0]!)).not.toBe(innerImageUrl);
    expect(firstImageUrl(offloaded).startsWith('blobref:image/png;')).toBe(true);
  });

  it('offloads every media container in content parts', async () => {
    const { store, blobsDir } = await makeStore();
    const payload = 'X'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;
    const parts = [imagePart(dataUri), videoPart(dataUri)];

    const offloaded = await store.offloadParts(parts);

    expect(firstImageUrl(offloaded).startsWith('blobref:image/png;')).toBe(true);
    expect(secondVideoUrl(offloaded).startsWith('blobref:image/png;')).toBe(true);
    expect(firstImageUrl(offloaded)).toBe(secondVideoUrl(offloaded));

    const files = await readdir(blobsDir);
    expect(files).toHaveLength(1);
  });

  it('returns the same array reference when nothing needs offloading', async () => {
    const { store } = await makeStore();
    const parts: readonly ContentPart[] = [{ type: 'text', text: 'just text' }];

    const offloaded = await store.offloadParts(parts);
    expect(offloaded).toBe(parts);
  });

  it('skips small data URIs below threshold', async () => {
    const { store, blobsDir } = await makeStore();
    const payload = 'short';
    const dataUri = `data:image/png;base64,${payload}`;
    const parts = [imagePart(dataUri)];

    const offloaded = await store.offloadParts(parts);

    expect(offloaded).toBe(parts);
    const files = await readdir(blobsDir).catch(() => []);
    expect(files).toHaveLength(0);
  });

  it('skips existing blobrefs during offload', async () => {
    const { store } = await makeStore();
    const parts = [imagePart('blobref:image/png;abc')];

    const offloaded = await store.offloadParts(parts);

    expect(offloaded).toBe(parts);
  });

  it('rehydrates blobrefs back to data URIs', async () => {
    const { store } = await makeStore();
    const payload = 'B'.repeat(5000);
    const dataUri = `data:image/jpeg;base64,${payload}`;

    const offloaded = await store.offloadParts([imagePart(dataUri)]);
    const rehydrated = await store.rehydrateParts(offloaded);

    expect(firstImageUrl(rehydrated)).toBe(dataUri);
    expect(firstImageUrl(offloaded)).toMatch(/^blobref:image\/jpeg;/);
  });

  it('replaces missing blobs with placeholder text', async () => {
    const { store } = await makeStore();
    const rehydrated = await store.rehydrateParts([imagePart('blobref:image/png;deadbeef')]);

    expect(firstImageUrl(rehydrated)).toBe(MISSING_MEDIA_PLACEHOLDER);
  });

  it('deduplicates identical payloads by hash', async () => {
    const { store, blobsDir } = await makeStore();
    const payload = 'C'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;

    await store.offloadParts([imagePart(dataUri)]);
    await store.offloadParts([imagePart(dataUri)]);

    const files = await readdir(blobsDir);
    expect(files).toHaveLength(1);
  });

  it('rehydrates from write-through cache after blob file is deleted', async () => {
    const { store, blobsDir } = await makeStore();
    const payload = 'E'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;

    const offloaded = await store.offloadParts([imagePart(dataUri)]);
    const files = await readdir(blobsDir);
    expect(files).toHaveLength(1);
    await rm(join(blobsDir, files[0]!));

    const rehydrated = await store.rehydrateParts(offloaded);
    expect(firstImageUrl(rehydrated)).toBe(dataUri);
  });

  it('rehydrates from read cache after first disk read', async () => {
    const { homeDir, blobsDir } = await makeHomeDir();
    const writer = createStore(homeDir);
    const reader = createStore(homeDir);
    const payload = 'F'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;

    const offloaded = await writer.offloadParts([imagePart(dataUri)]);
    const blobref = firstImageUrl(offloaded);

    const firstRead = await reader.rehydrateParts([imagePart(blobref)]);
    expect(firstImageUrl(firstRead)).toBe(dataUri);

    const files = await readdir(blobsDir);
    expect(files).toHaveLength(1);
    await rm(join(blobsDir, files[0]!));

    const secondRead = await reader.rehydrateParts([imagePart(blobref)]);
    expect(firstImageUrl(secondRead)).toBe(dataUri);
  });

  it('evicts least-recently-used entries when cache size limit is exceeded', async () => {
    const { homeDir, blobsDir } = await makeHomeDir();
    const store = createStore(homeDir, TwoBlobCacheStoreService);
    const payloadA = 'A'.repeat(5000);
    const payloadB = 'B'.repeat(5000);
    const payloadC = 'C'.repeat(5000);

    const offloadedA = await store.offloadParts([imagePart(`data:image/png;base64,${payloadA}`)]);
    const offloadedB = await store.offloadParts([imagePart(`data:image/png;base64,${payloadB}`)]);
    const blobrefA = firstImageUrl(offloadedA);
    const blobrefB = firstImageUrl(offloadedB);

    await store.rehydrateParts([imagePart(blobrefA)]);
    const offloadedC = await store.offloadParts([imagePart(`data:image/png;base64,${payloadC}`)]);
    const blobrefC = firstImageUrl(offloadedC);

    const files = await readdir(blobsDir);
    for (const file of files) {
      await rm(join(blobsDir, file));
    }

    expect(firstImageUrl(await store.rehydrateParts([imagePart(blobrefA)]))).toBe(
      `data:image/png;base64,${payloadA}`,
    );
    expect(firstImageUrl(await store.rehydrateParts([imagePart(blobrefB)]))).toBe(
      MISSING_MEDIA_PLACEHOLDER,
    );
    expect(firstImageUrl(await store.rehydrateParts([imagePart(blobrefC)]))).toBe(
      `data:image/png;base64,${payloadC}`,
    );
  });

  it('skips caching a blob larger than the entire cache cap', async () => {
    const { homeDir, blobsDir } = await makeHomeDir();
    const store = createStore(homeDir, OneBlobCacheStoreService);
    const small = 'S'.repeat(5000);
    const large = 'L'.repeat(10000);

    const offloadedSmall = await store.offloadParts([imagePart(`data:image/png;base64,${small}`)]);
    const offloadedLarge = await store.offloadParts([imagePart(`data:image/png;base64,${large}`)]);
    const smallBlobref = firstImageUrl(offloadedSmall);
    const largeBlobref = firstImageUrl(offloadedLarge);

    const files = await readdir(blobsDir);
    for (const file of files) {
      await rm(join(blobsDir, file));
    }

    expect(firstImageUrl(await store.rehydrateParts([imagePart(smallBlobref)]))).toBe(
      `data:image/png;base64,${small}`,
    );
    expect(firstImageUrl(await store.rehydrateParts([imagePart(largeBlobref)]))).toBe(
      MISSING_MEDIA_PLACEHOLDER,
    );
  });
});
