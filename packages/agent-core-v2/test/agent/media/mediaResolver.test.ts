import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import {
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, createServices, stubPair } from '#/_base/di/test';
import { buildKimiFileUrl, parseKimiFileUrl } from '#/agent/media/kimiFileUrl';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import { AgentMediaResolverService } from '#/agent/media/mediaResolverService';
import { IAgentVideoResolverService } from '#/agent/media/videoResolver';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { type GetResult, IFileService } from '#/app/file/fileService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { ContentPart, Message, VideoURLPart } from '#/kosong/contract/message';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import type { Protocol } from '#/kosong/protocol/protocol';
import { IBlobStore } from '#/persistence/interface/blobStore';

import { registerStateServices } from '../../state/stubs';

const FILE_ID = 'file_abc';
const FALLBACK_PATH = '/cache/file_abc.mp4';
const IMAGE_FALLBACK_PATH = '/cache/file_abc.png';
const VIDEO_BYTES = Buffer.from('tiny fake mp4 bytes');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const BMP_BYTES = Buffer.from([0x42, 0x4d, 0x46, 0x00, 0x00, 0x00, 0x00, 0x00]);
const MP4_MAGIC_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
]);
const IMAGE_UNAVAILABLE_TEXT = '[image omitted: the uploaded file is no longer available]';

function videoMessage(url: string): Message {
  return { role: 'user', content: [{ type: 'video_url', videoUrl: { url } }], toolCalls: [] };
}

function imageMessage(url: string, ...before: ContentPart[]): Message {
  return {
    role: 'user',
    content: [...before, { type: 'image_url', imageUrl: { url } }],
    toolCalls: [],
  };
}

function imagePathTagPart(path: string): ContentPart {
  return { type: 'text', text: `<image path="${path}"></image>` };
}

function firstPart(messages: readonly Message[]) {
  return messages[0]!.content[0]!;
}

function fileService(files: Map<string, { name: string; bytes: Buffer }>): IFileService {
  return {
    _serviceBrand: undefined,
    save: async () => {
      throw new Error('unused');
    },
    delete: async () => {},
    get: async (fileId): Promise<GetResult> => {
      const file = files.get(fileId);
      if (file === undefined) throw new Error(`file not found: ${fileId}`);
      return {
        meta: {
          id: fileId,
          name: file.name,
          media_type: 'video/mp4',
          size: file.bytes.length,
          created_at: new Date(0).toISOString(),
        },
        stream: () => Readable.from([file.bytes]),
      };
    },
  };
}

function blobStore(): IBlobStore {
  const data = new Map<string, Uint8Array>();
  return {
    _serviceBrand: undefined,
    put: async (scope, key, bytes) => {
      data.set(`${scope}/${key}`, bytes);
    },
    putStream: async (scope, key, source) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of source) chunks.push(chunk);
      data.set(`${scope}/${key}`, Buffer.concat(chunks));
    },
    get: async (scope, key) => data.get(`${scope}/${key}`),
    getStream: async function* () {},
    has: async (scope, key) => data.has(`${scope}/${key}`),
    delete: async (scope, key) => {
      data.delete(`${scope}/${key}`);
    },
    list: async () => [],
  };
}

const telemetry = { track2: () => {} } as unknown as ITelemetryService;

function requester(opts: {
  videoIn?: boolean;
  imageIn?: boolean;
  protocol?: Protocol;
  providerType?: string;
  uploadVideo?: ModelRequester['uploadVideo'];
}): ModelRequester {
  return {
    model: {
      id: 'm',
      name: 'stub',
      aliases: [],
      protocol: opts.protocol ?? 'openai',
      headers: {},
      capabilities: {
        video_in: opts.videoIn ?? true,
        image_in: opts.imageIn ?? true,
      } as unknown as ModelCapability,
      maxContextSize: 1000,
      alwaysThinking: false,
      providerName: 'p',
      providerType: opts.providerType ?? 'kimi',
      authProvider: {} as never,
    },
    request: () => {
      throw new Error('unused');
    },
    uploadVideo: opts.uploadVideo,
  };
}

function msPart(id: string): VideoURLPart {
  return { type: 'video_url', videoUrl: { url: `ms://${id}`, id } };
}

let disposables: DisposableStore;

beforeEach(() => {
  disposables = new DisposableStore();
});

afterEach(() => disposables.dispose());

function resolver(files: Map<string, { name: string; bytes: Buffer }>): IAgentMediaResolverService {
  const ix = createServices(disposables, {
    base: [registerStateServices],
    additionalServices: (reg) => {
      reg.defineInstance(IFileService, fileService(files));
      reg.defineInstance(IBlobStore, blobStore());
      reg.defineInstance(ITelemetryService, telemetry);
      reg.define(IAgentMediaResolverService, AgentMediaResolverService);
    },
  });
  return ix.get(IAgentMediaResolverService);
}

describe('kimiFileUrl', () => {
  it('round-trips a file id and an escaped materialization path', () => {
    const url = buildKimiFileUrl('file_1', '/a b/clip.mp4');
    expect(url).toBe(`kimi-file://file_1?path=${encodeURIComponent('/a b/clip.mp4')}`);
    expect(parseKimiFileUrl(url)).toEqual({ fileId: 'file_1', path: '/a b/clip.mp4' });
  });

  it('omits the query when no path is given', () => {
    expect(buildKimiFileUrl('file_1')).toBe('kimi-file://file_1');
    expect(parseKimiFileUrl('kimi-file://file_1')).toEqual({ fileId: 'file_1' });
  });

  it('returns undefined for any non-kimi-file url', () => {
    expect(parseKimiFileUrl('ms://prov-1')).toBeUndefined();
    expect(parseKimiFileUrl('data:video/mp4;base64,AAAA')).toBeUndefined();
    expect(parseKimiFileUrl('https://example.com/clip.mp4')).toBeUndefined();
  });
});

describe('AgentMediaResolverService video strategy', () => {
  it('uploads a kimi-file video once and reuses the cached reference on later steps', async () => {
    const upload = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-1'));
    const res = resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]));
    const req = requester({ uploadVideo: upload });
    const message = videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH));

    const first = await res.resolve([message], req);
    const second = await res.resolve([message], req);

    expect(firstPart(first)).toEqual(msPart('prov-1'));
    expect(firstPart(second)).toEqual(msPart('prov-1'));
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('reuses a persisted upload across resolver instances without re-uploading', async () => {
    const files = new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]);
    const blobs = blobStore();
    const message = videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH));

    // Two independent instances over one shared blob store: the container
    // hands out a singleton per token and would share the state service (and
    // with it the in-memory upload memo), so the persisted-cache path would
    // never run — direct construction is di-testing.md's two-instance
    // exception.
    const upload1 = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-1'));
    await new AgentMediaResolverService(fileService(files), blobs, telemetry, new AgentStateService()).resolve(
      [message],
      requester({ uploadVideo: upload1 }),
    );

    const upload2 = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-2'));
    const out = await new AgentMediaResolverService(fileService(files), blobs, telemetry, new AgentStateService()).resolve(
      [message],
      requester({ uploadVideo: upload2 }),
    );

    expect(firstPart(out)).toEqual(msPart('prov-1'));
    expect(upload1).toHaveBeenCalledTimes(1);
    expect(upload2).not.toHaveBeenCalled();
  });

  it('falls back to a path tag when the model cannot ingest video', async () => {
    const upload = vi.fn();
    const out = await resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]])).resolve(
      [videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH))],
      requester({ videoIn: false, uploadVideo: upload }),
    );

    expect(firstPart(out)).toEqual({ type: 'text', text: `<video path="${FALLBACK_PATH}"></video>` });
    expect(upload).not.toHaveBeenCalled();
  });

  it('inlines base64 for a no-upload provider whose wire carries video', async () => {
    const out = await resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]])).resolve(
      [videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH))],
      requester({ protocol: 'anthropic', uploadVideo: undefined }),
    );

    expect(firstPart(out)).toEqual({
      type: 'video_url',
      videoUrl: { url: `data:video/mp4;base64,${VIDEO_BYTES.toString('base64')}` },
    });
  });

  it('tags for a no-upload provider whose wire drops inline video (openai family)', async () => {
    const out = await resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]])).resolve(
      [videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH))],
      requester({ protocol: 'openai', uploadVideo: undefined }),
    );

    expect(firstPart(out)).toEqual({ type: 'text', text: `<video path="${FALLBACK_PATH}"></video>` });
  });

  it('rethrows an auth failure so it can drive credential refresh', async () => {
    const upload = vi.fn(async () => {
      throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    });
    const res = resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]));

    await expect(
      res.resolve([videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH))], requester({ uploadVideo: upload })),
    ).rejects.toThrow('unauthorized');
  });

  it('rethrows a cancelled upload without memoizing the fallback', async () => {
    const controller = new AbortController();
    // The rejection is deliberately NOT abort-shaped: the aborted signal alone
    // must decide cancellation, since abort error shapes vary by provider.
    const interrupted = vi.fn(async () => {
      controller.abort();
      throw new Error('socket closed');
    });
    const res = resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]));
    const message = videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH));

    await expect(
      res.resolve([message], requester({ uploadVideo: interrupted }), controller.signal),
    ).rejects.toThrow('socket closed');

    const retry = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-1'));
    const out = await res.resolve([message], requester({ uploadVideo: retry }));
    expect(firstPart(out)).toEqual(msPart('prov-1'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('retries the upload on a later step after a transient failure instead of freezing the tag', async () => {
    let uploadCalls = 0;
    const upload = vi.fn(async (): Promise<VideoURLPart> => {
      uploadCalls += 1;
      if (uploadCalls === 1) throw new Error('files endpoint unavailable');
      return msPart('prov-1');
    });
    const res = resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]));
    const message = videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH));
    const req = requester({ uploadVideo: upload });

    const failed = await res.resolve([message], req);
    expect(firstPart(failed)).toEqual({ type: 'text', text: `<video path="${FALLBACK_PATH}"></video>` });

    const retried = await res.resolve([message], req);
    expect(firstPart(retried)).toEqual(msPart('prov-1'));

    const memoed = await res.resolve([message], req);
    expect(firstPart(memoed)).toEqual(msPart('prov-1'));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('tags when the bytes do not sniff as a video', async () => {
    const upload = vi.fn();
    const out = await resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: PNG_BYTES }]])).resolve(
      [videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH))],
      requester({ uploadVideo: upload }),
    );

    expect(firstPart(out)).toEqual({ type: 'text', text: `<video path="${FALLBACK_PATH}"></video>` });
    expect(upload).not.toHaveBeenCalled();
  });

  it('tags a stale reference by its materialization path', async () => {
    const out = await resolver(new Map()).resolve(
      [videoMessage(buildKimiFileUrl('missing', FALLBACK_PATH))],
      requester({ uploadVideo: vi.fn() }),
    );

    expect(firstPart(out)).toEqual({ type: 'text', text: `<video path="${FALLBACK_PATH}"></video>` });
  });

  it('emits an unavailable placeholder when a stale reference has no fallback path', async () => {
    const out = await resolver(new Map()).resolve(
      [videoMessage(buildKimiFileUrl('missing'))],
      requester({ uploadVideo: vi.fn() }),
    );

    expect(firstPart(out)).toEqual({
      type: 'text',
      text: '[video omitted: the uploaded file is no longer available]',
    });
  });

  it('leaves messages without a kimi-file media reference untouched', async () => {
    const res = resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]));
    const messages = [videoMessage('ms://already-uploaded')];

    const out = await res.resolve(messages, requester({ uploadVideo: vi.fn() }));

    expect(out).toBe(messages);
  });
});

describe('AgentMediaResolverService image strategy', () => {
  it('inlines a daemon-ref image as a canonical base64 data url, leaving other parts untouched', async () => {
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));
    const tagPart = imagePathTagPart(IMAGE_FALLBACK_PATH);
    const remotePart: ContentPart = {
      type: 'image_url',
      imageUrl: { url: 'https://example.com/pic.png' },
    };
    const message = imageMessage(buildKimiFileUrl(FILE_ID, IMAGE_FALLBACK_PATH), tagPart, remotePart);

    const out = await res.resolve([message], requester({}));

    expect(out[0]!.content).toEqual([
      tagPart,
      remotePart,
      {
        type: 'image_url',
        imageUrl: { url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` },
      },
    ]);
  });

  it('drops the part when the model cannot ingest images and the reference carries a path', async () => {
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));
    const tagPart = imagePathTagPart(IMAGE_FALLBACK_PATH);
    const message = imageMessage(buildKimiFileUrl(FILE_ID, IMAGE_FALLBACK_PATH), tagPart);

    const out = await res.resolve([message], requester({ imageIn: false }));

    expect(out[0]!.content).toEqual([tagPart]);
  });

  it('emits an unavailable placeholder when the model cannot ingest images and there is no path', async () => {
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));
    const message = imageMessage(buildKimiFileUrl(FILE_ID));

    const out = await res.resolve([message], requester({ imageIn: false }));

    expect(out[0]!.content).toEqual([{ type: 'text', text: IMAGE_UNAVAILABLE_TEXT }]);
  });

  it('drops a stale reference by its materialization path', async () => {
    const res = resolver(new Map());
    const tagPart = imagePathTagPart(IMAGE_FALLBACK_PATH);
    const message = imageMessage(buildKimiFileUrl('missing', IMAGE_FALLBACK_PATH), tagPart);

    const out = await res.resolve([message], requester({}));

    expect(out[0]!.content).toEqual([tagPart]);
  });

  it('drops the part when the bytes sniff as a non-image media type', async () => {
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: MP4_MAGIC_BYTES }]]));
    const tagPart = imagePathTagPart(IMAGE_FALLBACK_PATH);
    const message = imageMessage(buildKimiFileUrl(FILE_ID, IMAGE_FALLBACK_PATH), tagPart);

    const out = await res.resolve([message], requester({}));

    expect(out[0]!.content).toEqual([tagPart]);
  });

  it('drops the part when the bytes sniff as an unaccepted image mime', async () => {
    const res = resolver(new Map([[FILE_ID, { name: 'pic.bmp', bytes: BMP_BYTES }]]));
    const tagPart = imagePathTagPart(IMAGE_FALLBACK_PATH);
    const message = imageMessage(buildKimiFileUrl(FILE_ID, IMAGE_FALLBACK_PATH), tagPart);

    const out = await res.resolve([message], requester({}));

    expect(out[0]!.content).toEqual([tagPart]);
  });

  it('synthesizes the path tag for a bare stale reference with no adjacent tag', async () => {
    const res = resolver(new Map());
    const message = imageMessage(buildKimiFileUrl('missing', IMAGE_FALLBACK_PATH));

    const out = await res.resolve([message], requester({}));

    expect(out[0]!.content).toEqual([
      { type: 'text', text: `<image path="${IMAGE_FALLBACK_PATH}"></image>` },
    ]);
  });

  it('emits an unavailable placeholder for a bare stale reference with no path', async () => {
    const res = resolver(new Map());
    const message = imageMessage(buildKimiFileUrl('missing'));

    const out = await res.resolve([message], requester({}));

    expect(out[0]!.content).toEqual([{ type: 'text', text: IMAGE_UNAVAILABLE_TEXT }]);
  });

  it('synthesizes the path tag when the model cannot ingest images and no adjacent tag exists', async () => {
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));
    const message = imageMessage(buildKimiFileUrl(FILE_ID, IMAGE_FALLBACK_PATH));

    const out = await res.resolve([message], requester({ imageIn: false }));

    expect(out[0]!.content).toEqual([
      { type: 'text', text: `<image path="${IMAGE_FALLBACK_PATH}"></image>` },
    ]);
  });

  it('synthesizes the path tag when the bytes sniff as an unaccepted image mime and no adjacent tag exists', async () => {
    const res = resolver(new Map([[FILE_ID, { name: 'pic.bmp', bytes: BMP_BYTES }]]));
    const message = imageMessage(buildKimiFileUrl(FILE_ID, IMAGE_FALLBACK_PATH));

    const out = await res.resolve([message], requester({}));

    expect(out[0]!.content).toEqual([
      { type: 'text', text: `<image path="${IMAGE_FALLBACK_PATH}"></image>` },
    ]);
  });

  it('synthesizes the path tag when the only adjacent tag references a different path', async () => {
    const res = resolver(new Map());
    const otherTag = imagePathTagPart('/cache/other.png');
    const message = imageMessage(buildKimiFileUrl('missing', IMAGE_FALLBACK_PATH), otherTag);

    const out = await res.resolve([message], requester({}));

    expect(out[0]!.content).toEqual([
      otherTag,
      { type: 'text', text: `<image path="${IMAGE_FALLBACK_PATH}"></image>` },
    ]);
  });

  it('synthesizes the path tag when the same-path tag is not adjacent to the reference', async () => {
    // The fold only claims ADJACENT pairs; a same-path tag elsewhere in the
    // message does not cover the reference, so the degrade must synthesize.
    const res = resolver(new Map());
    const tagPart = imagePathTagPart(IMAGE_FALLBACK_PATH);
    const message = imageMessage(
      buildKimiFileUrl('missing', IMAGE_FALLBACK_PATH),
      tagPart,
      { type: 'text', text: 'in between' },
    );

    const out = await res.resolve([message], requester({}));

    expect(out[0]!.content).toEqual([
      tagPart,
      { type: 'text', text: 'in between' },
      { type: 'text', text: `<image path="${IMAGE_FALLBACK_PATH}"></image>` },
    ]);
  });

  it('does not treat a tag embedded in user text as the adjacent tag', async () => {
    const res = resolver(new Map());
    const embedded: ContentPart = {
      type: 'text',
      text: `look <image path="${IMAGE_FALLBACK_PATH}"></image>`,
    };
    const message = imageMessage(buildKimiFileUrl('missing', IMAGE_FALLBACK_PATH), embedded);

    const out = await res.resolve([message], requester({}));

    expect(out[0]!.content).toEqual([
      embedded,
      { type: 'text', text: `<image path="${IMAGE_FALLBACK_PATH}"></image>` },
    ]);
  });

  it('claims one tag for at most one ref, synthesizing the tag for the unclaimed ref', async () => {
    const res = resolver(new Map());
    const tagPart = imagePathTagPart(IMAGE_FALLBACK_PATH);
    const first: ContentPart = {
      type: 'image_url',
      imageUrl: { url: buildKimiFileUrl('missing_1', IMAGE_FALLBACK_PATH) },
    };
    const second: ContentPart = {
      type: 'image_url',
      imageUrl: { url: buildKimiFileUrl('missing_2', IMAGE_FALLBACK_PATH) },
    };
    const message: Message = { role: 'user', content: [first, tagPart, second], toolCalls: [] };

    const out = await res.resolve([message], requester({}));

    expect(out[0]!.content).toEqual([
      tagPart,
      { type: 'text', text: `<image path="${IMAGE_FALLBACK_PATH}"></image>` },
    ]);
  });
});

describe('AgentMediaResolverService scoped registration', () => {
  let host: ReturnType<typeof createScopedTestHost>;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Agent,
      IAgentMediaResolverService,
      AgentMediaResolverService,
      ScopeActivation.OnScopeCreated,
      'media',
    );
  });

  afterEach(() => host.dispose());

  function agentScope(files: Map<string, { name: string; bytes: Buffer }>) {
    host = createScopedTestHost([
      stubPair(IFileService, fileService(files)),
      stubPair(IBlobStore, blobStore()),
      stubPair(ITelemetryService, telemetry),
    ]);
    return host.child(LifecycleScope.Agent, 'main', [
      stubPair(IAgentStateService, new AgentStateService()),
    ]);
  }

  it('resolves the media resolver token to a working instance through the scope tree', async () => {
    const agent = agentScope(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));

    const svc = agent.accessor.get(IAgentMediaResolverService);
    const out = await svc.resolve(
      [imageMessage(buildKimiFileUrl(FILE_ID, IMAGE_FALLBACK_PATH))],
      requester({}),
    );

    expect(firstPart(out)).toEqual({
      type: 'image_url',
      imageUrl: { url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` },
    });
  });

  it('resolves the legacy video-resolver alias to the same instance', () => {
    const agent = agentScope(new Map());

    expect(agent.accessor.get(IAgentVideoResolverService)).toBe(
      agent.accessor.get(IAgentMediaResolverService),
    );
  });
});
