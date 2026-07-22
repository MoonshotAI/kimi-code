import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { buildKimiFileUrl, parseKimiFileUrl } from '#/agent/media/kimiFileUrl';
import { AgentVideoResolverService } from '#/agent/media/videoResolverService';
import type { GetResult, IFileService } from '#/app/file/fileService';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { Message, VideoURLPart } from '#/kosong/contract/message';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import type { Protocol } from '#/kosong/protocol/protocol';
import type { IBlobStore } from '#/persistence/interface/blobStore';

const FILE_ID = 'file_abc';
const FALLBACK_PATH = '/cache/file_abc.mp4';
const VIDEO_BYTES = Buffer.from('tiny fake mp4 bytes');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

function videoMessage(url: string): Message {
  return { role: 'user', content: [{ type: 'video_url', videoUrl: { url } }], toolCalls: [] };
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
      capabilities: { video_in: opts.videoIn ?? true } as unknown as ModelCapability,
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

describe('AgentVideoResolverService', () => {
  it('uploads a kimi-file video once and reuses the cached reference on later steps', async () => {
    const upload = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-1'));
    const resolver = new AgentVideoResolverService(
      fileService(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]])),
      blobStore(),
      telemetry,
    );
    const req = requester({ uploadVideo: upload });
    const message = videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH));

    const first = await resolver.resolve([message], req);
    const second = await resolver.resolve([message], req);

    expect(firstPart(first)).toEqual(msPart('prov-1'));
    expect(firstPart(second)).toEqual(msPart('prov-1'));
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('reuses a persisted upload across resolver instances without re-uploading', async () => {
    const files = new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]);
    const blobs = blobStore();
    const message = videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH));

    const upload1 = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-1'));
    await new AgentVideoResolverService(fileService(files), blobs, telemetry).resolve(
      [message],
      requester({ uploadVideo: upload1 }),
    );

    const upload2 = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-2'));
    const out = await new AgentVideoResolverService(fileService(files), blobs, telemetry).resolve(
      [message],
      requester({ uploadVideo: upload2 }),
    );

    expect(firstPart(out)).toEqual(msPart('prov-1'));
    expect(upload1).toHaveBeenCalledTimes(1);
    expect(upload2).not.toHaveBeenCalled();
  });

  it('falls back to a path tag when the model cannot ingest video', async () => {
    const upload = vi.fn();
    const out = await new AgentVideoResolverService(
      fileService(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]])),
      blobStore(),
      telemetry,
    ).resolve([videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH))], requester({ videoIn: false, uploadVideo: upload }));

    expect(firstPart(out)).toEqual({ type: 'text', text: `<video path="${FALLBACK_PATH}"></video>` });
    expect(upload).not.toHaveBeenCalled();
  });

  it('inlines base64 for a no-upload provider whose wire carries video', async () => {
    const out = await new AgentVideoResolverService(
      fileService(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]])),
      blobStore(),
      telemetry,
    ).resolve([videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH))], requester({ protocol: 'anthropic', uploadVideo: undefined }));

    expect(firstPart(out)).toEqual({
      type: 'video_url',
      videoUrl: { url: `data:video/mp4;base64,${VIDEO_BYTES.toString('base64')}` },
    });
  });

  it('tags for a no-upload provider whose wire drops inline video (openai family)', async () => {
    const out = await new AgentVideoResolverService(
      fileService(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]])),
      blobStore(),
      telemetry,
    ).resolve([videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH))], requester({ protocol: 'openai', uploadVideo: undefined }));

    expect(firstPart(out)).toEqual({ type: 'text', text: `<video path="${FALLBACK_PATH}"></video>` });
  });

  it('rethrows an auth failure so it can drive credential refresh', async () => {
    const upload = vi.fn(async () => {
      throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    });
    const resolver = new AgentVideoResolverService(
      fileService(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]])),
      blobStore(),
      telemetry,
    );

    await expect(
      resolver.resolve([videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH))], requester({ uploadVideo: upload })),
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
    const resolver = new AgentVideoResolverService(
      fileService(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]])),
      blobStore(),
      telemetry,
    );
    const message = videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH));

    await expect(
      resolver.resolve([message], requester({ uploadVideo: interrupted }), controller.signal),
    ).rejects.toThrow('socket closed');

    const retry = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-1'));
    const out = await resolver.resolve([message], requester({ uploadVideo: retry }));
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
    const resolver = new AgentVideoResolverService(
      fileService(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]])),
      blobStore(),
      telemetry,
    );
    const message = videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH));
    const req = requester({ uploadVideo: upload });

    const failed = await resolver.resolve([message], req);
    expect(firstPart(failed)).toEqual({ type: 'text', text: `<video path="${FALLBACK_PATH}"></video>` });

    const retried = await resolver.resolve([message], req);
    expect(firstPart(retried)).toEqual(msPart('prov-1'));

    const memoed = await resolver.resolve([message], req);
    expect(firstPart(memoed)).toEqual(msPart('prov-1'));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('tags when the bytes do not sniff as a video', async () => {
    const upload = vi.fn();
    const out = await new AgentVideoResolverService(
      fileService(new Map([[FILE_ID, { name: 'clip.mp4', bytes: PNG_BYTES }]])),
      blobStore(),
      telemetry,
    ).resolve([videoMessage(buildKimiFileUrl(FILE_ID, FALLBACK_PATH))], requester({ uploadVideo: upload }));

    expect(firstPart(out)).toEqual({ type: 'text', text: `<video path="${FALLBACK_PATH}"></video>` });
    expect(upload).not.toHaveBeenCalled();
  });

  it('tags a stale reference by its materialization path', async () => {
    const out = await new AgentVideoResolverService(fileService(new Map()), blobStore(), telemetry).resolve(
      [videoMessage(buildKimiFileUrl('missing', FALLBACK_PATH))],
      requester({ uploadVideo: vi.fn() }),
    );

    expect(firstPart(out)).toEqual({ type: 'text', text: `<video path="${FALLBACK_PATH}"></video>` });
  });

  it('emits an unavailable placeholder when a stale reference has no fallback path', async () => {
    const out = await new AgentVideoResolverService(fileService(new Map()), blobStore(), telemetry).resolve(
      [videoMessage(buildKimiFileUrl('missing'))],
      requester({ uploadVideo: vi.fn() }),
    );

    expect(firstPart(out)).toEqual({
      type: 'text',
      text: '[video omitted: the uploaded file is no longer available]',
    });
  });

  it('leaves messages without a kimi-file video untouched', async () => {
    const resolver = new AgentVideoResolverService(
      fileService(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]])),
      blobStore(),
      telemetry,
    );
    const messages = [videoMessage('ms://already-uploaded')];

    const out = await resolver.resolve(messages, requester({ uploadVideo: vi.fn() }));

    expect(out).toBe(messages);
  });
});
