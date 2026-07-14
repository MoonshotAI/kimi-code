/**
 * Scenario: the agent blob service offloads large inline media (data URIs) into
 * content-addressed blobs and loads them back on read.
 *
 * Responsibilities asserted:
 *  - sub-threshold data URIs pass through unchanged (and keep the same array ref)
 *  - large data URIs become `blobref:` URLs and are persisted under the agent scope
 *  - offload is non-mutating, idempotent, and handles every media container
 *  - load restores blobrefs, leaves other URLs alone, and substitutes a
 *    placeholder when the blob is missing
 *  - content-addressing deduplicates identical payloads and isolates per agent
 *
 * Wiring: real `BlobStoreService` over the in-memory storage backend, with the
 * service resolved through the DI scope tree — no stubbed boundary, no real fs.
 *
 * Run: `pnpm test -- test/blob/agentBlobService.test.ts`
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContentPart } from '#/app/llmProtocol/message';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import {
  BLOBREF_PROTOCOL,
  IAgentBlobService,
  MISSING_MEDIA_PLACEHOLDER,
} from '#/agent/blob/agentBlobService';
import { AgentBlobServiceImpl } from '#/agent/blob/agentBlobServiceImpl';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { BlobStoreService } from '#/persistence/backends/node-fs/blobStoreService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

const LARGE = 'A'.repeat(5000);
const SMALL = 'AQID';

function dataUri(mimeType: string, payload: string): string {
  return `data:${mimeType};base64,${payload}`;
}

function imagePart(url: string): ContentPart {
  return { type: 'image_url', imageUrl: { url } };
}

function videoPart(url: string): ContentPart {
  return { type: 'video_url', videoUrl: { url } };
}

function imageUrl(part: ContentPart): string {
  return (part as { imageUrl: { url: string } }).imageUrl.url;
}

function videoUrl(part: ContentPart): string {
  return (part as { videoUrl: { url: string } }).videoUrl.url;
}

describe('agent blob service (offload/load of inline media)', () => {
  let host: ReturnType<typeof createScopedTestHost>;
  let blobs: IBlobStore;

  beforeEach(() => {
    host = createScopedTestHost([
      stubPair(IFileSystemStorageService, new InMemoryStorageService()),
      [IBlobStore as ServiceIdentifier<unknown>, new SyncDescriptor(BlobStoreService, [])],
    ]);
    blobs = host.app.accessor.get(IBlobStore);
  });

  afterEach(() => {
    host.dispose();
  });

  function createService(agentId: string, agentScope: string): IAgentBlobService {
    const agent = host.child(LifecycleScope.Agent, agentId, [
      stubPair(IAgentScopeContext, makeAgentScopeContext({ agentId, agentScope })),
      [IAgentBlobService as ServiceIdentifier<unknown>, new SyncDescriptor(AgentBlobServiceImpl)],
    ]);
    return agent.accessor.get(IAgentBlobService);
  }

  function service(): IAgentBlobService {
    return createService('agent', '');
  }

  it('offload leaves a sub-threshold data URI unchanged and returns the same array', async () => {
    const svc = service();
    const uri = dataUri('image/png', SMALL);
    const parts: ContentPart[] = [imagePart(uri)];

    const out = await svc.offloadParts(parts);

    expect(out).toBe(parts);
    expect(imageUrl(out[0]!)).toBe(uri);
  });

  it('offload rewrites a large data URI to a blobref persisted under the agent scope', async () => {
    const svc = service();
    const uri = dataUri('image/png', LARGE);

    const out = await svc.offloadParts([imagePart(uri)]);

    const ref = imageUrl(out[0]!);
    expect(svc.isBlobRef(ref)).toBe(true);
    expect(ref.startsWith(`${BLOBREF_PROTOCOL}image/png;`)).toBe(true);

    const keys = await blobs.list('blobs');
    expect(keys).toHaveLength(1);
    expect(Buffer.from((await blobs.get('blobs', keys[0]!))!).toString('base64')).toBe(LARGE);
  });

  it('offload then load restores the original data URI', async () => {
    const svc = service();
    const uri = dataUri('image/jpeg', LARGE);

    const out = await svc.offloadParts([imagePart(uri)]);
    const back = await svc.loadParts(out);

    expect(imageUrl(back[0]!)).toBe(uri);
  });

  it('offload does not mutate the input array or its media objects', async () => {
    const svc = service();
    const uri = dataUri('image/png', LARGE);
    const inner = { url: uri };
    const part = { type: 'image_url', imageUrl: inner } as ContentPart;
    const parts = [part];

    const out = await svc.offloadParts(parts);

    expect(out).not.toBe(parts);
    expect(out[0]).not.toBe(part);
    expect((out[0]! as { imageUrl: { url: string } }).imageUrl).not.toBe(inner);
    expect(inner.url).toBe(uri);
  });

  it('offload rewrites every media container in the part list', async () => {
    const svc = service();
    const uri = dataUri('image/png', LARGE);

    const out = await svc.offloadParts([imagePart(uri), videoPart(uri)]);

    expect(svc.isBlobRef(imageUrl(out[0]!))).toBe(true);
    expect(svc.isBlobRef(videoUrl(out[1]!))).toBe(true);

    const back = await svc.loadParts(out);
    expect(imageUrl(back[0]!)).toBe(uri);
    expect(videoUrl(back[1]!)).toBe(uri);
  });

  it('offload returns the input unchanged when no part carries media', async () => {
    const svc = service();
    const parts: ContentPart[] = [{ type: 'text', text: 'just text' }];

    expect(await svc.offloadParts(parts)).toBe(parts);
  });

  it('offload leaves an existing blobref untouched', async () => {
    const svc = service();
    const parts: ContentPart[] = [imagePart('blobref:image/png;deadbeef')];

    expect(await svc.offloadParts(parts)).toBe(parts);
  });

  it('offload maps identical payloads to the same blobref and stores them once', async () => {
    const svc = service();
    const uri = dataUri('image/png', LARGE);

    const first = await svc.offloadParts([imagePart(uri)]);
    const second = await svc.offloadParts([imagePart(uri)]);

    expect(imageUrl(first[0]!)).toBe(imageUrl(second[0]!));
    expect(await blobs.list('blobs')).toHaveLength(1);
  });

  it('offload isolates blobs per agent scope so agents do not collide', async () => {
    const a1 = createService('a1', 'sessions/s1/agents/a1');
    const a2 = createService('a2', 'sessions/s1/agents/a2');
    const uri = dataUri('image/png', LARGE);

    const out1 = await a1.offloadParts([imagePart(uri)]);
    const out2 = await a2.offloadParts([imagePart(uri)]);

    expect(await blobs.list('sessions/s1/agents/a1/blobs')).toHaveLength(1);
    expect(await blobs.list('sessions/s1/agents/a2/blobs')).toHaveLength(1);
    expect(imageUrl((await a1.loadParts(out1))[0]!)).toBe(uri);
    expect(imageUrl((await a2.loadParts(out2))[0]!)).toBe(uri);
  });

  it('load leaves non-blobref URLs unchanged and returns the same array', async () => {
    const svc = service();
    const parts: ContentPart[] = [
      imagePart('https://example.com/a.png'),
      imagePart(dataUri('image/png', SMALL)),
    ];

    expect(await svc.loadParts(parts)).toBe(parts);
  });

  it('load substitutes the missing-media placeholder when the blob is absent', async () => {
    const svc = service();

    const out = await svc.loadParts([imagePart('blobref:image/png;deadbeef')]);

    expect(imageUrl(out[0]!)).toBe(MISSING_MEDIA_PLACEHOLDER);
  });

  it('isBlobRef recognizes only the blobref protocol', () => {
    const svc = service();

    expect(svc.isBlobRef('blobref:image/png;abc')).toBe(true);
    expect(svc.isBlobRef('data:image/png;base64,AQID')).toBe(false);
    expect(svc.isBlobRef('https://example.com/a.png')).toBe(false);
  });
});
