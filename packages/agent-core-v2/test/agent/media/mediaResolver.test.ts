import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { createScopedTestHost, createServices, stubPair } from '#/_base/di/test';
import { buildKimiFileUrl } from '#/agent/media/kimiFileUrl';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import { AgentMediaResolverService } from '#/agent/media/mediaResolverService';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
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
const VIDEO_BYTES = Buffer.from('tiny fake mp4 bytes');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const BMP_BYTES = Buffer.from([0x42, 0x4d, 0x46, 0x00, 0x00, 0x00, 0x00, 0x00]);
const MP4_MAGIC_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
]);
const IMAGE_UNAVAILABLE_TEXT = '[image omitted: the uploaded file is no longer available]';
const VIDEO_UNAVAILABLE_TEXT = '[video omitted: the uploaded file is no longer available]';
const VIDEO_TAG = '<video path="/cache/file_abc.mp4"></video>';
const IMAGE_TAG = '<image path="/cache/file_abc.png"></image>';
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

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

function countingFileService(files: Map<string, { name: string; bytes: Buffer }>): {
  service: IFileService;
  readonly gets: number;
} {
  const base = fileService(files);
  let gets = 0;
  return {
    service: {
      ...base,
      get: async (fileId) => {
        gets++;
        return base.get(fileId);
      },
    },
    get gets() {
      return gets;
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

function stubMediaStore(sessionDir = '/nonexistent-session'): ISessionMediaStore {
  return {
    _serviceBrand: undefined,
    pathFor: (fileId, ext) => join(sessionDir, 'media', `${fileId}${ext}`),
    resolveDisplayPath: async (fileId) => {
      const dir = join(sessionDir, 'media');
      const keys: string[] = await readdir(dir).catch(() => []);
      const key = keys.find((name) => name === fileId || name.startsWith(`${fileId}.`));
      return key === undefined ? undefined : join(dir, key);
    },
    read: async () => undefined,
    open: async () => undefined,
    materialize: async () => {
      throw new Error('unused');
    },
  };
}

let sessionDir: string;

async function plantCanonical(fileId: string, ext: string, bytes: Buffer): Promise<string> {
  const canonical = join(sessionDir, 'media', `${fileId}${ext}`);
  await mkdir(join(sessionDir, 'media'), { recursive: true });
  await writeFile(canonical, bytes);
  return canonical;
}

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

beforeEach(async () => {
  disposables = new DisposableStore();
  sessionDir = await mkdtemp(join(tmpdir(), 'media-resolver-'));
});

afterEach(async () => {
  disposables.dispose();
  await rm(sessionDir, { recursive: true, force: true });
});

function resolver(
  files: Map<string, { name: string; bytes: Buffer }>,
  sessionDir?: string,
  mediaStore: ISessionMediaStore = stubMediaStore(sessionDir),
): IAgentMediaResolverService {
  const ix = createServices(disposables, {
    base: [registerStateServices],
    additionalServices: (reg) => {
      reg.defineInstance(IFileService, fileService(files));
      reg.defineInstance(IBlobStore, blobStore());
      reg.defineInstance(ITelemetryService, telemetry);
      reg.defineInstance(ISessionMediaStore, mediaStore);
      reg.define(IAgentMediaResolverService, AgentMediaResolverService);
    },
  });
  return ix.get(IAgentMediaResolverService);
}

describe('AgentMediaResolverService video strategy', () => {
  it('uploads a kimi-file video once and reuses the cached reference on later steps', async () => {
    const upload = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-1'));
    const res = resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]));
    const req = requester({ uploadVideo: upload });
    const message = videoMessage(buildKimiFileUrl(FILE_ID));

    const first = await res.resolve([message], req);
    const second = await res.resolve([message], req);

    expect(firstPart(first)).toEqual(msPart('prov-1'));
    expect(firstPart(second)).toEqual(msPart('prov-1'));
    expect(upload).toHaveBeenCalledTimes(1);

    const plain = [videoMessage('ms://already-uploaded')];
    expect(await res.resolve(plain, req)).toBe(plain);
  });

  it('degrades to the path tag when the current model cannot accept video, ignoring a memoized upload', async () => {
    const upload = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-1'));
    const canonical = await plantCanonical(FILE_ID, '.mp4', VIDEO_BYTES);
    const res = resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]), sessionDir);
    const message = videoMessage(buildKimiFileUrl(FILE_ID));

    const capable = await res.resolve([message], requester({ uploadVideo: upload }));
    expect(firstPart(capable)).toEqual(msPart('prov-1'));

    const incapable = await res.resolve(
      [message],
      requester({ videoIn: false, uploadVideo: upload }),
    );
    expect(firstPart(incapable)).toEqual({
      type: 'text',
      text: `<video path="${canonical}"></video>`,
    });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('reuses a persisted upload across resolver instances without re-uploading', async () => {
    const files = new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]);
    const blobs = blobStore();
    const message = videoMessage(buildKimiFileUrl(FILE_ID));

    const upload1 = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-1'));
    await new AgentMediaResolverService(fileService(files), blobs, telemetry, new AgentStateService(), stubMediaStore()).resolve(
      [message],
      requester({ uploadVideo: upload1 }),
    );

    const upload2 = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-2'));
    const out = await new AgentMediaResolverService(fileService(files), blobs, telemetry, new AgentStateService(), stubMediaStore()).resolve(
      [message],
      requester({ uploadVideo: upload2 }),
    );

    expect(firstPart(out)).toEqual(msPart('prov-1'));
    expect(upload1).toHaveBeenCalledTimes(1);
    expect(upload2).not.toHaveBeenCalled();
  });

  type TagCase = {
    name: string;
    files: Map<string, { name: string; bytes: Buffer }>;
    fileId: string;
    req: (upload: ModelRequester['uploadVideo']) => ModelRequester;
  };

  it.each<TagCase>([
    {
      name: 'the model cannot ingest video',
      files: new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]),
      fileId: FILE_ID,
      req: (upload) => requester({ videoIn: false, uploadVideo: upload }),
    },
    {
      name: 'a no-upload provider whose wire drops inline video (openai family)',
      files: new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]),
      fileId: FILE_ID,
      req: () => requester({ protocol: 'openai', uploadVideo: undefined }),
    },
    {
      name: 'the bytes do not sniff as a video',
      files: new Map([[FILE_ID, { name: 'clip.mp4', bytes: PNG_BYTES }]]),
      fileId: FILE_ID,
      req: (upload) => requester({ uploadVideo: upload }),
    },
    {
      name: 'the reference is stale',
      files: new Map(),
      fileId: 'missing',
      req: (upload) => requester({ uploadVideo: upload }),
    },
  ])('degrades when $name', async ({ files, fileId, req }) => {
    const upload = vi.fn();
    const canonical =
      fileId === FILE_ID ? await plantCanonical(FILE_ID, '.mp4', VIDEO_BYTES) : undefined;
    const out = await resolver(files, sessionDir).resolve(
      [videoMessage(buildKimiFileUrl(fileId))],
      req(upload),
    );

    expect(firstPart(out)).toEqual({
      type: 'text',
      text: canonical === undefined ? VIDEO_UNAVAILABLE_TEXT : `<video path="${canonical}"></video>`,
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it('rethrows an auth failure so it can drive credential refresh', async () => {
    const upload = vi.fn(async () => {
      throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    });
    const res = resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]));

    await expect(
      res.resolve([videoMessage(buildKimiFileUrl(FILE_ID))], requester({ uploadVideo: upload })),
    ).rejects.toThrow('unauthorized');
  });

  it('rethrows a cancelled upload without memoizing the fallback', async () => {
    const controller = new AbortController();
    const interrupted = vi.fn(async () => {
      controller.abort();
      throw new Error('socket closed');
    });
    const res = resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]));
    const message = videoMessage(buildKimiFileUrl(FILE_ID));

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
    const canonical = await plantCanonical(FILE_ID, '.mp4', VIDEO_BYTES);
    const res = resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]), sessionDir);
    const message = videoMessage(buildKimiFileUrl(FILE_ID));
    const req = requester({ uploadVideo: upload });

    const failed = await res.resolve([message], req);
    expect(firstPart(failed)).toEqual({
      type: 'text',
      text: `<video path="${canonical}"></video>`,
    });

    const retried = await res.resolve([message], req);
    expect(firstPart(retried)).toEqual(msPart('prov-1'));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('emits an unavailable placeholder when a stale reference has no canonical copy', async () => {
    const out = await resolver(new Map()).resolve(
      [videoMessage(buildKimiFileUrl('missing'))],
      requester({ uploadVideo: vi.fn() }),
    );

    expect(firstPart(out)).toEqual({
      type: 'text',
      text: VIDEO_UNAVAILABLE_TEXT,
    });
  });
});

describe('AgentMediaResolverService canonical session bytes', () => {
  it.each([
    {
      kind: 'video',
      bytes: VIDEO_BYTES,
      fileName: `${FILE_ID}.mp4`,
      message: videoMessage(buildKimiFileUrl(FILE_ID)),
      expected: msPart('prov-1'),
      uploads: 1,
    },
    {
      kind: 'image',
      bytes: PNG_BYTES,
      fileName: `${FILE_ID}.png`,
      message: imageMessage(buildKimiFileUrl(FILE_ID)),
      expected: { type: 'image_url', imageUrl: { url: PNG_DATA_URL } },
      uploads: 0,
    },
  ])(
    'reads canonical session bytes for a $kind after the transient upload is released',
    async ({ bytes, fileName, message, expected, uploads }) => {
      const mediaStore = stubMediaStore();
      mediaStore.read = async () => ({ data: bytes, name: fileName });
      const res = resolver(new Map(), undefined, mediaStore);
      const upload = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-1'));

      const out = await res.resolve([message], requester({ uploadVideo: upload }));

      expect(upload).toHaveBeenCalledTimes(uploads);
      expect(firstPart(out)).toEqual(expected);
    },
  );
});

describe('AgentMediaResolverService image strategy', () => {
  it('inlines a daemon-ref image as a canonical base64 data url, leaving other parts untouched', async () => {
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));
    const tagPart: ContentPart = { type: 'text', text: IMAGE_TAG };
    const remotePart: ContentPart = {
      type: 'image_url',
      imageUrl: { url: 'https://example.com/pic.png' },
    };
    const message = imageMessage(buildKimiFileUrl(FILE_ID), tagPart, remotePart);

    const out = await res.resolve([message], requester({}));

    expect(out[0]!.content).toEqual([
      tagPart,
      remotePart,
      { type: 'image_url', imageUrl: { url: PNG_DATA_URL } },
    ]);
  });

  it('rethrows a cancelled image read instead of degrading to a tag', async () => {
    const controller = new AbortController();
    const files: IFileService = {
      _serviceBrand: undefined,
      save: async () => {
        throw new Error('unused');
      },
      delete: async () => {},
      get: async (fileId): Promise<GetResult> => ({
        meta: {
          id: fileId,
          name: 'pic.png',
          media_type: 'image/png',
          size: PNG_BYTES.length,
          created_at: new Date(0).toISOString(),
        },
        stream: () =>
          Readable.from(
            (async function* () {
              yield PNG_BYTES;
              controller.abort();
              throw new Error('socket closed');
            })(),
          ),
      }),
    };
    const res = new AgentMediaResolverService(
      files,
      blobStore(),
      telemetry,
      new AgentStateService(),
      stubMediaStore(),
    );

    await expect(
      res.resolve(
        [imageMessage(buildKimiFileUrl(FILE_ID))],
        requester({}),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each([
    {
      name: 'the model cannot ingest images',
      files: new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]),
      fileId: FILE_ID,
      imageIn: false,
    },
    {
      name: 'the reference is stale',
      files: new Map<string, { name: string; bytes: Buffer }>(),
      fileId: 'missing',
      imageIn: true,
    },
    {
      name: 'the bytes sniff as a non-image media type',
      files: new Map([[FILE_ID, { name: 'pic.png', bytes: MP4_MAGIC_BYTES }]]),
      fileId: FILE_ID,
      imageIn: true,
    },
    {
      name: 'the bytes sniff as an unaccepted image mime',
      files: new Map([[FILE_ID, { name: 'pic.bmp', bytes: BMP_BYTES }]]),
      fileId: FILE_ID,
      imageIn: true,
    },
  ])('degrades when $name', async ({ files, fileId, imageIn }) => {
    const canonical =
      fileId === FILE_ID ? await plantCanonical(FILE_ID, '.png', PNG_BYTES) : undefined;
    const message = imageMessage(buildKimiFileUrl(fileId));

    const out = await resolver(files, sessionDir).resolve([message], requester({ imageIn }));

    expect(out[0]!.content).toEqual([
      {
        type: 'text',
        text:
          canonical === undefined ? IMAGE_UNAVAILABLE_TEXT : `<image path="${canonical}"></image>`,
      },
    ]);
  });

  it.each([
    {
      name: 'the model cannot ingest images and there is no canonical copy',
      files: new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]),
      url: buildKimiFileUrl(FILE_ID),
      imageIn: false,
      expected: IMAGE_UNAVAILABLE_TEXT,
    },
    {
      name: 'a bare stale reference has no canonical copy',
      files: new Map<string, { name: string; bytes: Buffer }>(),
      url: buildKimiFileUrl('missing'),
      imageIn: true,
      expected: IMAGE_UNAVAILABLE_TEXT,
    },
  ])('emits the fallback text part when $name', async ({ files, url, imageIn, expected }) => {
    const out = await resolver(files).resolve([imageMessage(url)], requester({ imageIn }));

    expect(out[0]!.content).toEqual([{ type: 'text', text: expected }]);
  });

  it('memoizes an inlined image across resolves without re-reading the bytes', async () => {
    const files = new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]);
    const counting = countingFileService(files);
    const res = new AgentMediaResolverService(
      counting.service,
      blobStore(),
      telemetry,
      new AgentStateService(),
      stubMediaStore(),
    );
    const message = imageMessage(buildKimiFileUrl(FILE_ID));
    const expected = { type: 'image_url', imageUrl: { url: PNG_DATA_URL } };

    const first = await res.resolve([message], requester({}));
    files.delete(FILE_ID);
    const second = await res.resolve(
      [message],
      requester({ providerType: 'other', protocol: 'anthropic' }),
    );

    expect(firstPart(first)).toEqual(expected);
    expect(firstPart(second)).toEqual(expected);
    expect(counting.gets).toBe(1);
  });

  it('re-reads an oversized image instead of memoizing its base64', async () => {
    const bigBytes = Buffer.concat([PNG_BYTES, Buffer.alloc(8 * 1024 * 1024)]);
    const files = new Map([[FILE_ID, { name: 'pic.png', bytes: bigBytes }]]);
    const counting = countingFileService(files);
    const res = new AgentMediaResolverService(
      counting.service,
      blobStore(),
      telemetry,
      new AgentStateService(),
      stubMediaStore(),
    );
    const message = imageMessage(buildKimiFileUrl(FILE_ID));

    const first = await res.resolve([message], requester({}));
    const second = await res.resolve([message], requester({}));

    expect(firstPart(first)).toEqual(firstPart(second));
    expect(counting.gets).toBe(2);
  });

  it('evicts the least-recently-hit memo entry once the total byte budget is exceeded', async () => {
    const bigPng = (): Buffer =>
      Buffer.concat([PNG_BYTES, Buffer.alloc(8 * 1024 * 1024 - PNG_BYTES.length)]);
    const ids = Array.from({ length: 9 }, (_, i) => `file_${i}`);
    const files = new Map(ids.map((id) => [id, { name: 'pic.png', bytes: bigPng() }]));
    const counting = countingFileService(files);
    const res = new AgentMediaResolverService(
      counting.service,
      blobStore(),
      telemetry,
      new AgentStateService(),
      stubMediaStore(),
    );
    const req = requester({});

    for (const id of ids.slice(0, 8)) {
      await res.resolve([imageMessage(buildKimiFileUrl(id))], req);
    }
    await res.resolve([imageMessage(buildKimiFileUrl('file_0'))], req);
    await res.resolve([imageMessage(buildKimiFileUrl('file_8'))], req);
    expect(counting.gets).toBe(9);

    await res.resolve([imageMessage(buildKimiFileUrl('file_0'))], req);
    expect(counting.gets).toBe(9);
    await res.resolve([imageMessage(buildKimiFileUrl('file_1'))], req);
    expect(counting.gets).toBe(10);
  });

  it.each([
    {
      name: 'the model cannot ingest images',
      present: true,
      imageIn: false,
      reads: 1,
    },
    {
      name: 'the bytes are initially unreadable',
      present: false,
      imageIn: true,
      reads: 2,
    },
  ])(
    'does not memoize a degrade when $name, resolving inline once it can',
    async ({ present, imageIn, reads }) => {
      const files = new Map<string, { name: string; bytes: Buffer }>();
      if (present) files.set(FILE_ID, { name: 'pic.png', bytes: PNG_BYTES });
      const counting = countingFileService(files);
      const canonical = await plantCanonical(FILE_ID, '.png', PNG_BYTES);
      const res = new AgentMediaResolverService(
        counting.service,
        blobStore(),
        telemetry,
        new AgentStateService(),
        stubMediaStore(sessionDir),
      );
      const message = imageMessage(buildKimiFileUrl(FILE_ID));

      const degraded = await res.resolve([message], requester({ imageIn }));
      if (!present) files.set(FILE_ID, { name: 'pic.png', bytes: PNG_BYTES });
      const out = await res.resolve([message], requester({}));

      expect(firstPart(degraded)).toEqual({
        type: 'text',
        text: `<image path="${canonical}"></image>`,
      });
      expect(firstPart(out)).toEqual({ type: 'image_url', imageUrl: { url: PNG_DATA_URL } });
      expect(counting.gets).toBe(reads);
    },
  );
});

describe('AgentMediaResolverService session-canonical display path', () => {
  it.each([
    {
      name: 'synthesizes the degrade tag from the canonical path when it exists',
      canonical: true,
    },
    {
      name: 'emits the unavailable placeholder when no canonical copy exists',
      canonical: false,
    },
  ])('$name', async ({ canonical: plant }) => {
    const canonical = plant ? await plantCanonical(FILE_ID, '.png', PNG_BYTES) : undefined;
    const message = imageMessage(buildKimiFileUrl(FILE_ID));

    const out = await resolver(new Map(), sessionDir).resolve([message], requester({ imageIn: false }));

    expect(out[0]!.content).toEqual([
      {
        type: 'text',
        text:
          canonical === undefined ? IMAGE_UNAVAILABLE_TEXT : `<image path="${canonical}"></image>`,
      },
    ]);
  });

  it('refreshes the degrade form when the canonical copy appears', async () => {
    const res = resolver(new Map(), sessionDir);
    const message = videoMessage(buildKimiFileUrl(FILE_ID));
    const req = requester({ videoIn: false });

    const first = await res.resolve([message], req);
    expect(firstPart(first)).toEqual({ type: 'text', text: VIDEO_UNAVAILABLE_TEXT });

    const canonical = await plantCanonical(FILE_ID, '.mp4', VIDEO_BYTES);
    const second = await res.resolve([message], req);
    expect(firstPart(second)).toEqual({ type: 'text', text: `<video path="${canonical}"></video>` });
  });

  it('keeps a legacy persisted tag as text and degrades the reference with a synthesized tag', async () => {
    const canonical = await plantCanonical(FILE_ID, '.mp4', VIDEO_BYTES);
    const message: Message = {
      role: 'user',
      toolCalls: [],
      content: [
        { type: 'text', text: VIDEO_TAG },
        { type: 'video_url', videoUrl: { url: buildKimiFileUrl(FILE_ID) } },
      ],
    };
    const out = await resolver(new Map(), sessionDir).resolve(
      [message],
      requester({ videoIn: false }),
    );
    expect(out[0]!.content).toEqual([
      { type: 'text', text: VIDEO_TAG },
      { type: 'text', text: `<video path="${canonical}"></video>` },
    ]);
  });

  it('keeps a legacy persisted tag as text when the reference degrades to the placeholder', async () => {
    const res = resolver(new Map(), sessionDir);
    const req = requester({ videoIn: false });
    const bare: Message = {
      role: 'user',
      toolCalls: [],
      content: [
        { type: 'video_url', videoUrl: { url: buildKimiFileUrl(FILE_ID) } },
      ],
    };
    const first = await res.resolve([bare], req);
    expect(firstPart(first)).toEqual({ type: 'text', text: VIDEO_UNAVAILABLE_TEXT });

    const withLegacyTag: Message = {
      role: 'user',
      toolCalls: [],
      content: [
        { type: 'text', text: VIDEO_TAG },
        { type: 'video_url', videoUrl: { url: buildKimiFileUrl(FILE_ID) } },
      ],
    };
    const second = await res.resolve([withLegacyTag], req);
    expect(second[0]!.content).toEqual([
      { type: 'text', text: VIDEO_TAG },
      { type: 'text', text: VIDEO_UNAVAILABLE_TEXT },
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

  afterEach(() => {
    host.dispose();
  });

  function agentScope(files: Map<string, { name: string; bytes: Buffer }>) {
    host = createScopedTestHost([
      stubPair(IFileService, fileService(files)),
      stubPair(IBlobStore, blobStore()),
      stubPair(ITelemetryService, telemetry),
    ]);
    return host.child(LifecycleScope.Agent, 'main', [
      stubPair(IAgentStateService, new AgentStateService()),
      stubPair(ISessionMediaStore, stubMediaStore()),
    ]);
  }

  it('resolves the media resolver token to a working instance through the scope tree', async () => {
    const agent = agentScope(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));

    const svc = agent.accessor.get(IAgentMediaResolverService);
    const out = await svc.resolve(
      [imageMessage(buildKimiFileUrl(FILE_ID))],
      requester({}),
    );

    expect(firstPart(out)).toEqual({ type: 'image_url', imageUrl: { url: PNG_DATA_URL } });
  });

  it('resolves the legacy video-resolver alias to the same instance', () => {
    const agent = agentScope(new Map());

    expect(agent.accessor.get(IAgentVideoResolverService)).toBe(
      agent.accessor.get(IAgentMediaResolverService),
    );
  });
});
