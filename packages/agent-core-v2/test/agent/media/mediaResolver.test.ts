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
import type { Event2 } from '#/app/event/event2';
import { buildKimiFileUrl } from '#/agent/media/kimiFileUrl';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import { AgentMediaResolverService } from '#/agent/media/mediaResolverService';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { type GetResult, IFileService } from '#/app/file/fileService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ModelCapability } from '#/llm-adapter/contract/capability';
import type { Message } from '#/llm-adapter/contract/message';
import type { ContentPart, ImageURLPart, VideoURLPart } from '#human/llm/message';
import type { LlmCredentialProvider } from '#human/llm/requester/requester';
import type { ModelRequester } from '#/llm-adapter/model/model-requester';
import type { Protocol } from '#/llm-adapter/protocol/protocol';
import { IBlobStore } from '#/persistence/interface/blobStore';

import { registerStateServices } from '../../state/stubs';
import { createStaticCredentialProvider } from '#human/credentials/credentials';
import { ImageUploadUnsupportedError } from '#/llm-adapter/contract/errors';

const FILE_ID = 'file_abc';
const VIDEO_BYTES = Buffer.from('tiny fake mp4 bytes');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const BMP_BYTES = Buffer.from([0x42, 0x4d, 0x46, 0x00, 0x00, 0x00, 0x00, 0x00]);
const TIFF_BYTES = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
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

const stubDispatcher = {
  _serviceBrand: undefined,
  dispatch: async () => {},
} as unknown as IEventDispatcher;

const stubScopeContext = makeAgentScopeContext({ agentId: 'main', agentScope: '' });

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
  baseUrl?: string;
  headers?: Record<string, string>;
  uploadVideo?: ModelRequester['uploadVideo'];
  uploadImage?: ModelRequester['uploadImage'];
  credentialProvider?: LlmCredentialProvider;
}): ModelRequester {
  return {
    model: {
      id: 'm',
      name: 'stub',
      aliases: [],
      protocol: opts.protocol ?? 'openai',
      baseUrl: opts.baseUrl,
      headers: opts.headers ?? {},
      capabilities: {
        video_in: opts.videoIn ?? true,
        image_in: opts.imageIn ?? true,
      } as unknown as ModelCapability,
      maxContextSize: 1000,
      alwaysThinking: false,
      providerName: 'p',
      providerType: opts.providerType ?? 'kimi',
      credentialProvider: opts.credentialProvider,
    },
    request: () => {
      throw new Error('unused');
    },
    uploadVideo: opts.uploadVideo,
    uploadImage: opts.uploadImage,
  };
}

function msPart(id: string): VideoURLPart {
  return { type: 'video_url', videoUrl: { url: `ms://${id}`, id } };
}

function msImagePart(id: string): ImageURLPart {
  return { type: 'image_url', imageUrl: { url: `ms://${id}`, id } };
}

function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.${Buffer.from('sig').toString('base64url')}`;
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
  events: Event2[] = [],
): IAgentMediaResolverService {
  const ix = createServices(disposables, {
    base: [registerStateServices],
    additionalServices: (reg) => {
      reg.defineInstance(IFileService, fileService(files));
      reg.defineInstance(IBlobStore, blobStore());
      reg.defineInstance(ITelemetryService, telemetry);
      reg.defineInstance(ISessionMediaStore, mediaStore);
      reg.defineInstance(IEventDispatcher, {
        _serviceBrand: undefined,
        dispatch: async (event: Event2) => {
          events.push(event);
        },
      } as unknown as IEventDispatcher);
      reg.defineInstance(
        IAgentScopeContext,
        makeAgentScopeContext({ agentId: 'main', agentScope: '' }),
      );
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
    await new AgentMediaResolverService(fileService(files), blobs, telemetry, new AgentStateService(), stubMediaStore(), stubDispatcher, stubScopeContext).resolve(
      [message],
      requester({ uploadVideo: upload1 }),
    );

    const upload2 = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-2'));
    const out = await new AgentMediaResolverService(fileService(files), blobs, telemetry, new AgentStateService(), stubMediaStore(), stubDispatcher, stubScopeContext).resolve(
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

  it('invalidates recoverable credentials and retries the upload once on a 401', async () => {
    let invalidations = 0;
    const credentialProvider: LlmCredentialProvider = {
      resolve: () => ({ apiKey: 'tok' }),
      canRecover: (error) => (error as { statusCode?: number }).statusCode === 401,
      invalidate: () => {
        invalidations += 1;
      },
    };
    const upload = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-9'));
    upload.mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { statusCode: 401 }));
    const res = resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]));

    const out = await res.resolve(
      [videoMessage(buildKimiFileUrl(FILE_ID))],
      requester({ uploadVideo: upload, credentialProvider }),
    );

    expect(firstPart(out)).toEqual(msPart('prov-9'));
    expect(upload).toHaveBeenCalledTimes(2);
    expect(invalidations).toBe(1);
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

  it('re-uploads when the resolved account changes, reusing the upload while it stays the same', async () => {
    const upload = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-1'));
    const res = resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]));
    const message = videoMessage(buildKimiFileUrl(FILE_ID));
    const accountA = requester({ uploadVideo: upload, credentialProvider: createStaticCredentialProvider('key-a') });

    await res.resolve([message], accountA);
    await res.resolve([message], accountA);
    expect(upload).toHaveBeenCalledTimes(1);

    const accountB = requester({ uploadVideo: upload, credentialProvider: createStaticCredentialProvider('key-b') });
    const out = await res.resolve([message], accountB);

    expect(firstPart(out)).toEqual(msPart('prov-1'));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('reuses the cached upload across access-token rotation when the JWT subject is stable', async () => {
    const upload = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-1'));
    const res = resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]));
    const message = videoMessage(buildKimiFileUrl(FILE_ID));
    const base = {
      client_id: 'client-1',
      device_id: 'device-1',
      scope: 'kimi-code',
      iss: 'kimi-auth',
      type: 'access',
    };
    const tokenA = fakeJwt({ ...base, sub: 'user-1', token_id: 'tok-1', iat: 100, exp: 200 });
    const tokenB = fakeJwt({ ...base, sub: 'user-1', token_id: 'tok-2', iat: 300, exp: 400 });
    const tokenC = fakeJwt({ ...base, sub: 'user-2', token_id: 'tok-3', iat: 500, exp: 600 });

    await res.resolve([message], requester({ uploadVideo: upload, credentialProvider: createStaticCredentialProvider(tokenA) }));
    await res.resolve([message], requester({ uploadVideo: upload, credentialProvider: createStaticCredentialProvider(tokenB) }));
    expect(upload).toHaveBeenCalledTimes(1);

    await res.resolve([message], requester({ uploadVideo: upload, credentialProvider: createStaticCredentialProvider(tokenC) }));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('re-uploads when the endpoint changes for the same account', async () => {
    const upload = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-1'));
    const res = resolver(new Map([[FILE_ID, { name: 'clip.mp4', bytes: VIDEO_BYTES }]]));
    const message = videoMessage(buildKimiFileUrl(FILE_ID));
    const endpointA = requester({
      uploadVideo: upload,
      credentialProvider: createStaticCredentialProvider('key-a'),
      baseUrl: 'https://a.example.test/v1',
    });

    await res.resolve([message], endpointA);
    await res.resolve([message], endpointA);
    expect(upload).toHaveBeenCalledTimes(1);

    const endpointB = requester({
      uploadVideo: upload,
      credentialProvider: createStaticCredentialProvider('key-a'),
      baseUrl: 'https://b.example.test/v1',
    });
    const out = await res.resolve([message], endpointB);

    expect(firstPart(out)).toEqual(msPart('prov-1'));
    expect(upload).toHaveBeenCalledTimes(2);
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
      stubDispatcher,
      stubScopeContext,
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
      files: new Map([[FILE_ID, { name: 'scan.tiff', bytes: TIFF_BYTES }]]),
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

  it('delivers a format inline only when the current model provider accepts it', async () => {
    const files = new Map([[FILE_ID, { name: 'pic.bmp', bytes: BMP_BYTES }]]);
    const canonical = await plantCanonical(FILE_ID, '.bmp', BMP_BYTES);
    const message = imageMessage(buildKimiFileUrl(FILE_ID));

    const kimi = await resolver(files, sessionDir).resolve([message], requester({}));
    const other = await resolver(files, sessionDir).resolve(
      [message],
      requester({ providerType: 'anthropic', protocol: 'anthropic' }),
    );

    expect(firstPart(kimi)).toEqual({
      type: 'image_url',
      imageUrl: { url: `data:image/bmp;base64,${BMP_BYTES.toString('base64')}` },
    });
    expect(firstPart(other)).toEqual({ type: 'text', text: `<image path="${canonical}"></image>` });
  });

  it('never serves a memoized image to a provider that rejects its format', async () => {
    const files = new Map([[FILE_ID, { name: 'pic.bmp', bytes: BMP_BYTES }]]);
    const canonical = await plantCanonical(FILE_ID, '.bmp', BMP_BYTES);
    const res = resolver(files, sessionDir);
    const message = imageMessage(buildKimiFileUrl(FILE_ID));
    const inline = {
      type: 'image_url',
      imageUrl: { url: `data:image/bmp;base64,${BMP_BYTES.toString('base64')}` },
    };

    expect(firstPart(await res.resolve([message], requester({})))).toEqual(inline);
    const other = requester({ providerType: 'anthropic', protocol: 'anthropic' });
    expect(firstPart(await res.resolve([message], other))).toEqual({
      type: 'text',
      text: `<image path="${canonical}"></image>`,
    });
    expect(firstPart(await res.resolve([message], requester({})))).toEqual(inline);
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
      stubDispatcher,
      stubScopeContext,
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
      stubDispatcher,
      stubScopeContext,
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
      stubDispatcher,
      stubScopeContext,
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
        stubDispatcher,
        stubScopeContext,
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

describe('AgentMediaResolverService image upload', () => {
  it('uploads an image once and serves later resolves from the cached reference', async () => {
    const upload = vi.fn(async (): Promise<ImageURLPart> => msImagePart('img-1'));
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));
    const req = requester({ uploadImage: upload });
    const message = imageMessage(buildKimiFileUrl(FILE_ID));

    const first = await res.resolve([message], req);
    const second = await res.resolve([message], req);

    expect(firstPart(first)).toEqual(msImagePart('img-1'));
    expect(firstPart(second)).toEqual(msImagePart('img-1'));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(
      { data: PNG_BYTES, mimeType: 'image/png', filename: 'pic.png' },
      expect.anything(),
    );
  });

  it('reuses a persisted image upload across resolver instances without re-uploading', async () => {
    const files = new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]);
    const blobs = blobStore();
    const message = imageMessage(buildKimiFileUrl(FILE_ID));

    const upload1 = vi.fn(async (): Promise<ImageURLPart> => msImagePart('img-1'));
    await new AgentMediaResolverService(fileService(files), blobs, telemetry, new AgentStateService(), stubMediaStore(), stubDispatcher, stubScopeContext).resolve(
      [message],
      requester({ uploadImage: upload1 }),
    );

    const upload2 = vi.fn(async (): Promise<ImageURLPart> => msImagePart('img-2'));
    const out = await new AgentMediaResolverService(fileService(files), blobs, telemetry, new AgentStateService(), stubMediaStore(), stubDispatcher, stubScopeContext).resolve(
      [message],
      requester({ uploadImage: upload2 }),
    );

    expect(firstPart(out)).toEqual(msImagePart('img-1'));
    expect(upload1).toHaveBeenCalledTimes(1);
    expect(upload2).not.toHaveBeenCalled();
  });

  it('falls back to the inline base64 part when the upload fails for a non-auth reason', async () => {
    const upload = vi.fn(async (): Promise<ImageURLPart> => {
      throw new Error('files endpoint unavailable');
    });
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));

    const out = await res.resolve(
      [imageMessage(buildKimiFileUrl(FILE_ID))],
      requester({ uploadImage: upload }),
    );

    expect(firstPart(out)).toEqual({ type: 'image_url', imageUrl: { url: PNG_DATA_URL } });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('rethrows an auth failure so it can drive credential refresh', async () => {
    const upload = vi.fn(async () => {
      throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    });
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));

    await expect(
      res.resolve([imageMessage(buildKimiFileUrl(FILE_ID))], requester({ uploadImage: upload })),
    ).rejects.toThrow('unauthorized');
  });

  it('rethrows an auth failure exposed through the SDK status field', async () => {
    const upload = vi.fn(async () => {
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    });
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));

    await expect(
      res.resolve([imageMessage(buildKimiFileUrl(FILE_ID))], requester({ uploadImage: upload })),
    ).rejects.toThrow('unauthorized');
  });

  it('keeps the inline base64 part when the requester has no image uploader', async () => {
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));

    const out = await res.resolve(
      [imageMessage(buildKimiFileUrl(FILE_ID))],
      requester({ uploadImage: undefined }),
    );

    expect(firstPart(out)).toEqual({ type: 'image_url', imageUrl: { url: PNG_DATA_URL } });
  });

  it('re-uploads when the resolved account changes, reusing the upload while it stays the same', async () => {
    const upload = vi.fn(async (): Promise<ImageURLPart> => msImagePart('img-1'));
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));
    const message = imageMessage(buildKimiFileUrl(FILE_ID));
    const accountA = requester({ uploadImage: upload, credentialProvider: createStaticCredentialProvider('key-a') });

    await res.resolve([message], accountA);
    await res.resolve([message], accountA);
    expect(upload).toHaveBeenCalledTimes(1);

    const accountB = requester({ uploadImage: upload, credentialProvider: createStaticCredentialProvider('key-b') });
    const out = await res.resolve([message], accountB);

    expect(firstPart(out)).toEqual(msImagePart('img-1'));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('re-uploads when the endpoint changes for the same account', async () => {
    const upload = vi.fn(async (): Promise<ImageURLPart> => msImagePart('img-1'));
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));
    const message = imageMessage(buildKimiFileUrl(FILE_ID));
    const endpointA = requester({
      uploadImage: upload,
      credentialProvider: createStaticCredentialProvider('key-a'),
      baseUrl: 'https://a.example.test/v1',
    });

    await res.resolve([message], endpointA);
    await res.resolve([message], endpointA);
    expect(upload).toHaveBeenCalledTimes(1);

    const endpointB = requester({
      uploadImage: upload,
      credentialProvider: createStaticCredentialProvider('key-a'),
      baseUrl: 'https://b.example.test/v1',
    });
    const out = await res.resolve([message], endpointB);

    expect(firstPart(out)).toEqual(msImagePart('img-1'));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('re-uploads when the protocol changes the effective files endpoint', async () => {
    const ids = ['openai-image', 'anthropic-image'];
    let nextId = 0;
    const upload = vi.fn(async (): Promise<ImageURLPart> => msImagePart(ids[nextId++]!));
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));
    const message = imageMessage(buildKimiFileUrl(FILE_ID));
    const openai = requester({
      uploadImage: upload,
      credentialProvider: createStaticCredentialProvider('key-a'),
      protocol: 'openai',
      baseUrl: 'https://api.example.test',
    });
    const anthropic = requester({
      uploadImage: upload,
      credentialProvider: createStaticCredentialProvider('key-a'),
      protocol: 'anthropic',
      baseUrl: 'https://api.example.test',
    });

    await res.resolve([message], openai);
    const out = await res.resolve([message], anthropic);

    expect(firstPart(out)).toEqual(msImagePart('anthropic-image'));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('re-uploads when the effective authorization changes', async () => {
    const ids = ['account-a-image', 'account-b-image'];
    let nextId = 0;
    const upload = vi.fn(async (): Promise<ImageURLPart> => msImagePart(ids[nextId++]!));
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));
    const message = imageMessage(buildKimiFileUrl(FILE_ID));
    const accountA = requester({
      uploadImage: upload,
      credentialProvider: createStaticCredentialProvider('catalog-key'),
      baseUrl: 'https://api.example.test/v1',
      headers: { Authorization: 'Bearer account-a' },
    });
    const accountB = requester({
      uploadImage: upload,
      credentialProvider: createStaticCredentialProvider('catalog-key'),
      baseUrl: 'https://api.example.test/v1',
      headers: { Authorization: 'Bearer account-b' },
    });

    await res.resolve([message], accountA);
    const out = await res.resolve([message], accountB);

    expect(firstPart(out)).toEqual(msImagePart('account-b-image'));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('stops probing the upload endpoint after the requester declares image upload unsupported', async () => {
    const upload = vi.fn(async (): Promise<ImageURLPart> => {
      throw new ImageUploadUnsupportedError('no image upload');
    });
    const res = resolver(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));
    const req = requester({ uploadImage: upload });
    const message = imageMessage(buildKimiFileUrl(FILE_ID));

    const first = await res.resolve([message], req);
    const second = await res.resolve([message], req);

    expect(firstPart(first)).toEqual({ type: 'image_url', imageUrl: { url: PNG_DATA_URL } });
    expect(firstPart(second)).toEqual({ type: 'image_url', imageUrl: { url: PNG_DATA_URL } });
    expect(upload).toHaveBeenCalledTimes(1);
  });
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

describe('AgentMediaResolverService request media budget', () => {
  const EIGHT_MIB = 8 * 1024 * 1024;
  const SIX_MIB = 6 * 1024 * 1024;
  const ONE_MIB = 1024 * 1024;

  function bigPng(size: number): Buffer {
    return Buffer.concat([PNG_BYTES, Buffer.alloc(size - PNG_BYTES.length)]);
  }

  function imageFiles(entries: Array<[string, number]>): Map<string, { name: string; bytes: Buffer }> {
    return new Map(entries.map(([id, size]) => [id, { name: `${id}.png`, bytes: bigPng(size) }]));
  }

  function imageMessages(ids: readonly string[]): Message[] {
    return ids.map((id) => imageMessage(buildKimiFileUrl(id)));
  }

  function inlineImageMessages(ids: readonly string[]): Message[] {
    return ids.map((id) => imageMessage(`data:image/png;base64,${id}${'A'.repeat(EIGHT_MIB)}`));
  }

  function partTypes(messages: readonly Message[]): string[] {
    return messages.map((message) => message.content[0]!.type);
  }

  function warnings(events: readonly Event2[]): Event2[] {
    return events.filter((event) => event.type === 'warning');
  }

  it('omits the oldest inline media without daemon file references', async () => {
    const events: Event2[] = [];
    const res = resolver(new Map(), sessionDir, undefined, events);
    const messages = inlineImageMessages(['first', 'second', 'third']);

    const out = await res.resolve(messages, requester({}));

    expect(partTypes(out)).toEqual(['text', 'text', 'image_url']);
    expect(out[2]!.content[0]).toBe(messages[2]!.content[0]);
    expect(warnings(events)).toEqual([
      expect.objectContaining({ type: 'warning', code: 'media-budget-exceeded' }),
    ]);
  });

  it('omits the oldest images in one batch when inline media exceed the budget', async () => {
    const files = imageFiles([
      ['f1', SIX_MIB],
      ['f2', SIX_MIB],
      ['f3', SIX_MIB],
    ]);
    const p1 = await plantCanonical('f1', '.png', files.get('f1')!.bytes);
    const p2 = await plantCanonical('f2', '.png', files.get('f2')!.bytes);
    const events: Event2[] = [];
    const res = resolver(files, sessionDir, undefined, events);

    const out = await res.resolve(imageMessages(['f1', 'f2', 'f3']), requester({}));

    expect(out[0]!.content).toEqual([{ type: 'text', text: `<image path="${p1}"></image>` }]);
    expect(out[1]!.content).toEqual([{ type: 'text', text: `<image path="${p2}"></image>` }]);
    expect(out[2]!.content[0]).toEqual({
      type: 'image_url',
      imageUrl: { url: `data:image/png;base64,${files.get('f3')!.bytes.toString('base64')}` },
    });
    expect(warnings(events)).toEqual([
      expect.objectContaining({ type: 'warning', code: 'media-budget-exceeded' }),
    ]);
  });

  it('omits every occurrence when the same image appears multiple times', async () => {
    const files = imageFiles([
      ['big', 12 * 1024 * 1024],
      ['small', SIX_MIB],
    ]);
    const events: Event2[] = [];
    const res = resolver(files, sessionDir, undefined, events);

    const out = await res.resolve(imageMessages(['big', 'big', 'small']), requester({}));

    expect(partTypes(out)).toEqual(['text', 'text', 'image_url']);
  });

  it('keeps the drop set stable while later requests stay under the high watermark', async () => {
    const files = imageFiles([
      ['f1', SIX_MIB],
      ['f2', SIX_MIB],
      ['f3', SIX_MIB],
      ['f4', ONE_MIB],
    ]);
    await plantCanonical('f1', '.png', files.get('f1')!.bytes);
    await plantCanonical('f2', '.png', files.get('f2')!.bytes);
    const events: Event2[] = [];
    const res = resolver(files, sessionDir, undefined, events);
    const first3 = imageMessages(['f1', 'f2', 'f3']);

    const first = await res.resolve(first3, requester({}));
    const second = await res.resolve(
      [...first3, ...imageMessages(['f4'])],
      requester({}),
    );

    expect(second.slice(0, 3)).toEqual(first);
    expect(second[3]!.content[0]).toEqual({
      type: 'image_url',
      imageUrl: { url: `data:image/png;base64,${files.get('f4')!.bytes.toString('base64')}` },
    });
    expect(warnings(events)).toHaveLength(1);
  });

  it('evicts the next batch only after the budget is exceeded again', async () => {
    const files = imageFiles([
      ['f1', SIX_MIB],
      ['f2', SIX_MIB],
      ['f3', SIX_MIB],
      ['f5', SIX_MIB],
      ['f6', SIX_MIB],
      ['f7', SIX_MIB],
    ]);
    const events: Event2[] = [];
    const res = resolver(files, sessionDir, undefined, events);

    await res.resolve(imageMessages(['f1', 'f2', 'f3']), requester({}));
    const messages = imageMessages(['f1', 'f2', 'f3', 'f5', 'f6', 'f7']);
    const out = await res.resolve(messages, requester({}));

    expect(partTypes(out)).toEqual(['text', 'text', 'text', 'text', 'text', 'image_url']);
    expect(warnings(events)).toHaveLength(2);

    const again = await res.resolve(messages, requester({}));
    expect(again).toEqual(out);
    expect(warnings(events)).toHaveLength(2);
  });

  it('does not count uploaded references toward the budget', async () => {
    const upload = vi.fn(async (): Promise<VideoURLPart> => msPart('prov-1'));
    const files = imageFiles([
      ['f1', SIX_MIB],
      ['f2', SIX_MIB],
      ['f3', SIX_MIB],
    ]);
    files.set('v1', { name: 'clip.mp4', bytes: VIDEO_BYTES });
    const events: Event2[] = [];
    const res = resolver(files, sessionDir, undefined, events);
    const req = requester({ uploadVideo: upload });

    const out = await res.resolve(
      [videoMessage(buildKimiFileUrl('v1')), ...imageMessages(['f1', 'f2', 'f3'])],
      req,
    );

    expect(out[0]!.content[0]).toEqual(msPart('prov-1'));
    expect(partTypes(out)).toEqual(['video_url', 'text', 'text', 'image_url']);

    const again = await res.resolve([videoMessage(buildKimiFileUrl('v1'))], req);
    expect(again[0]!.content[0]).toEqual(msPart('prov-1'));
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
      stubPair(IEventDispatcher, {
        _serviceBrand: undefined,
        dispatch: async () => {},
      } as unknown as IEventDispatcher),
      stubPair(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: '' })),
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
});

describe('AgentMediaResolverService displayPaths', () => {
  it('maps daemon file ref urls to their display paths', async () => {
    await plantCanonical('f_img', '.png', PNG_BYTES);
    const service = resolver(new Map(), sessionDir);

    const paths = await service.displayPaths([
      imageMessage(buildKimiFileUrl('f_img')),
      imageMessage('data:image/png;base64,AAAA'),
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ]);

    expect(paths.get(buildKimiFileUrl('f_img'))).toBe(join(sessionDir, 'media', 'f_img.png'));
    expect(paths.size).toBe(1);
  });

  it('omits refs without a display path and dedupes repeated urls', async () => {
    const service = resolver(new Map(), sessionDir);

    const paths = await service.displayPaths([
      imageMessage(buildKimiFileUrl('f_missing')),
      imageMessage(buildKimiFileUrl('f_missing')),
      videoMessage(buildKimiFileUrl('f_missing')),
    ]);

    expect(paths.size).toBe(0);
  });
});
