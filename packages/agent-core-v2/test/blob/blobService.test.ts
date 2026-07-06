import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContentPart } from '#/app/llmProtocol';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { AgentBlobServiceImpl, IAgentBlobService } from '#/agent/blob';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext';
import { IBootstrapService } from '#/app/bootstrap';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { BlobStoreService } from '#/persistence/backends/node-fs/blobStoreService';

function makeLargeDataUri(mimeType = 'image/png'): { uri: string; payload: string } {
  // The default threshold is 4096 base64 characters.
  const payload = 'A'.repeat(5000);
  return { uri: `data:${mimeType};base64,${payload}`, payload };
}

function makeSmallDataUri(mimeType = 'image/png'): { uri: string; payload: string } {
  const payload = 'AQID';
  return { uri: `data:${mimeType};base64,${payload}`, payload };
}

describe('AgentBlobServiceImpl', () => {
  let host: ReturnType<typeof createScopedTestHost>;

  beforeEach(() => {
    host = createScopedTestHost([
      stubPair(IFileSystemStorageService, new InMemoryStorageService()),
      stubPair(IBootstrapService, { homeDir: '/home' } as unknown as IBootstrapService),
      [IBlobStore as ServiceIdentifier<unknown>, new SyncDescriptor(BlobStoreService, [])],
    ]);
  });

  afterEach(() => {
    host.dispose();
  });

  function getBlobStore(): IAgentBlobService {
    const agent = host.child(LifecycleScope.Agent, 'test-agent', [
      [
        IAgentScopeContext as ServiceIdentifier<unknown>,
        makeAgentScopeContext({ agentId: 'test-agent', agentScope: '' }),
      ],
      [
        IAgentBlobService as ServiceIdentifier<unknown>,
        new SyncDescriptor(AgentBlobServiceImpl, [{}]),
      ],
    ]);
    return agent.accessor.get(IAgentBlobService);
  }

  it('leaves small data URIs unchanged', async () => {
    const store = getBlobStore();
    const { uri } = makeSmallDataUri();
    const parts: ContentPart[] = [{ type: 'image_url', imageUrl: { url: uri } }];

    const result = await store.offloadParts(parts);

    expect(result).toBe(parts);
    expect((result[0]! as { imageUrl: { url: string } }).imageUrl.url).toBe(uri);
  });

  it('offloads large data URIs to blobref URIs', async () => {
    const store = getBlobStore();
    const { uri, payload } = makeLargeDataUri();
    const parts: ContentPart[] = [{ type: 'image_url', imageUrl: { url: uri } }];

    const result = await store.offloadParts(parts);

    expect(result).not.toBe(parts);
    const newUrl = (result[0]! as { imageUrl: { url: string } }).imageUrl.url;
    expect(store.isBlobRef(newUrl)).toBe(true);
    expect(newUrl.startsWith('blobref:image/png;')).toBe(true);

    const backend = host.app.accessor.get(IFileSystemStorageService);
    const keys = await backend.list('blobs');
    expect(keys).toHaveLength(1);
    expect(Buffer.from((await backend.read('blobs', keys[0]!))!).toString('base64')).toBe(payload);
  });

  it('rehydrates blobref URIs back to data URIs', async () => {
    const store = getBlobStore();
    const { uri } = makeLargeDataUri();
    const parts: ContentPart[] = [{ type: 'image_url', imageUrl: { url: uri } }];

    const offloaded = await store.offloadParts(parts);
    const rehydrated = await store.rehydrateParts(offloaded);

    expect((rehydrated[0]! as { imageUrl: { url: string } }).imageUrl.url).toBe(uri);
  });

  it('rehydrates only blobref URLs and leaves other URLs alone', async () => {
    const store = getBlobStore();
    const { uri: largeUri } = makeLargeDataUri();
    const { uri: smallUri } = makeSmallDataUri();
    const parts: ContentPart[] = [
      { type: 'image_url', imageUrl: { url: largeUri } },
      { type: 'audio_url', audioUrl: { url: smallUri } },
    ];

    const offloaded = await store.offloadParts(parts);
    expect(store.isBlobRef((offloaded[0]! as { imageUrl: { url: string } }).imageUrl.url)).toBe(true);
    expect((offloaded[1]! as { audioUrl: { url: string } }).audioUrl.url).toBe(smallUri);

    const rehydrated = await store.rehydrateParts(offloaded);
    expect((rehydrated[0]! as { imageUrl: { url: string } }).imageUrl.url).toBe(largeUri);
    expect((rehydrated[1]! as { audioUrl: { url: string } }).audioUrl.url).toBe(smallUri);
  });

  it('replaces missing blobs with a placeholder', async () => {
    const store = getBlobStore();
    const parts: ContentPart[] = [
      { type: 'image_url', imageUrl: { url: 'blobref:image/png;deadbeef' } },
    ];

    const result = await store.rehydrateParts(parts);

    expect((result[0]! as { imageUrl: { url: string } }).imageUrl.url).toBe('[media missing]');
  });

  it('is idempotent across offload/rehydrate cycles', async () => {
    const store = getBlobStore();
    const { uri } = makeLargeDataUri();
    const parts: ContentPart[] = [{ type: 'image_url', imageUrl: { url: uri } }];

    const first = await store.offloadParts(parts);
    const second = await store.offloadParts(first);

    expect((second[0]! as { imageUrl: { url: string } }).imageUrl.url).toBe(
      (first[0]! as { imageUrl: { url: string } }).imageUrl.url,
    );
  });

  it('persists blobs under the per-agent scope when homedir is seeded', async () => {
    const agent = host.child(LifecycleScope.Agent, 'a1', [
      [
        IAgentScopeContext as ServiceIdentifier<unknown>,
        makeAgentScopeContext({
          agentId: 'a1',
          agentScope: 'sessions/s1/agents/a1',
        }),
      ],
      [
        IAgentBlobService as ServiceIdentifier<unknown>,
        new SyncDescriptor(AgentBlobServiceImpl, [{}]),
      ],
    ]);
    const store = agent.accessor.get(IAgentBlobService);
    const { uri, payload } = makeLargeDataUri();
    const parts: ContentPart[] = [{ type: 'image_url', imageUrl: { url: uri } }];

    const offloaded = await store.offloadParts(parts);
    expect(store.isBlobRef((offloaded[0]! as { imageUrl: { url: string } }).imageUrl.url)).toBe(true);

    const backend = host.app.accessor.get(IFileSystemStorageService);
    const perAgentScope = 'sessions/s1/agents/a1/blobs';
    const perAgentKeys = await backend.list(perAgentScope);
    expect(perAgentKeys).toHaveLength(1);
    expect(
      Buffer.from((await backend.read(perAgentScope, perAgentKeys[0]!))!).toString('base64'),
    ).toBe(payload);
    expect(await backend.list('blobs')).toHaveLength(0);

    const rehydrated = await store.rehydrateParts(offloaded);
    expect((rehydrated[0]! as { imageUrl: { url: string } }).imageUrl.url).toBe(uri);
  });
});
