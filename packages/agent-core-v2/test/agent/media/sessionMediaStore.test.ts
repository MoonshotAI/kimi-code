import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Jimp } from 'jimp';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { SessionMediaStoreService } from '#/agent/media/sessionMediaStoreService';
import { mcpResultToExecutableOutput } from '#/agent/mcp/output';
import { detectFileType } from '#/agent/media/file-type';
import { renderToolResultForModel } from '#/agent/contextMemory/toolResultRender';
import { lowerMessage as lowerOpenAI } from '#human/llm/requester/bases/openai/lower';
import { lowerMessage as lowerAnthropic } from '#human/llm/requester/bases/anthropic/lower';
import { providerImagePolicy } from '#human/llm/media/image-formats';
import type { ToolMessage } from '#human/llm/message';
import { degradeOlderMediaParts } from '#/agent/contextProjector/mediaProjection';
import { parseDaemonFileUrl } from '#/agent/media/mediaRef';
import type { Message } from '#/llm-adapter/contract/message';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';

const BYTES = Buffer.from('media bytes');

function modelText(result: Awaited<ReturnType<typeof mcpResultToExecutableOutput>>): string {
  return renderToolResultForModel(result).map((part) => part.type === 'text' ? part.text : '').join('\n');
}

function streamOf(bytes: Buffer): () => NodeJS.ReadableStream {
  return () => Readable.from([bytes]);
}

describe('SessionMediaStoreService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let homeDir: string;
  let sessionDir: string;
  let store: ISessionMediaStore;

  beforeEach(async () => {
    disposables = new DisposableStore();
    homeDir = await mkdtemp(join(tmpdir(), 'session-media-store-home-'));
    sessionDir = join(homeDir, 'sessions', 's1');
    await mkdir(sessionDir, { recursive: true });
    ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(ISessionContext, makeSessionContext({
          sessionId: 's1',
          workspaceId: 'w1',
          sessionDir,
          sessionScope: join('sessions', 's1'),
          cwd: '/tmp',
        }));
        reg.defineInstance(IFileSystemStorageService, new FileStorageService(homeDir));
        reg.define(IAtomicDocumentStore, JsonAtomicDocumentStore);
        reg.define(ISessionMediaStore, SessionMediaStoreService);
      },
    });
    store = ix.get(ISessionMediaStore);
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  function input(overrides: Partial<Parameters<ISessionMediaStore['materialize']>[0]> = {}) {
    return {
      fileId: 'f_1',
      size: BYTES.length,
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      stream: streamOf(BYTES),
      ...overrides,
    };
  }

  function pathFor(fileId: string, ext: string): string {
    const path = store.pathFor(fileId, ext);
    expect(path).toBeDefined();
    return path!;
  }

  it('materializes at the storage-backed canonical path', async () => {
    const target = await store.materialize(input());
    expect(target).toBe(pathFor('f_1', '.mp4'));
    expect(target).toBe(join(sessionDir, 'media', 'f_1.mp4'));
    expect(await readFile(target!)).toEqual(BYTES);
  });

  it('preserves an embedded MCP PDF as bytes at the advertised session path', async () => {
    const bytes = Buffer.from('%PDF-1.4\nexample attachment\n%%EOF');
    const output = await mcpResultToExecutableOutput({
      isError: false,
      content: [{ type: 'resource', resource: {
        uri: 'example://report', mimeType: 'application/pdf', blob: bytes.toString('base64'),
      } }],
    }, 'mcp__example__report', { attachmentStore: store });
    const path = /Original attachment saved at: ("[^\n]+")/.exec(modelText(output))?.[1];
    expect(path).toBeDefined();
    const savedPath = JSON.parse(path!) as string;
    expect(savedPath.startsWith(join(sessionDir, 'media') + '/')).toBe(true);
    expect(savedPath.endsWith('.pdf')).toBe(true);
    expect(await readFile(savedPath)).toEqual(bytes);
  });

  it.each(['image/tiff', 'audio/wav', 'video/mp4'])('preserves an omitted MCP %s attachment exactly', async (mimeType) => {
    const bytes = mimeType === 'image/tiff'
      ? Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0])
      : Buffer.alloc(10 * 1024 * 1024 + 1, 0x63);
    const output = await mcpResultToExecutableOutput({
      isError: false,
      content: [{ type: 'resource', resource: {
        uri: 'example://attachment', mimeType, blob: bytes.toString('base64'),
      } }],
    }, 'mcp__example__attachment', { attachmentStore: store, providerType: 'anthropic' });
    const encodedPath = /Original attachment saved at: ("[^\n]+")/.exec(modelText(output))?.[1];
    expect(encodedPath).toBeDefined();
    expect((await readFile(JSON.parse(encodedPath!) as string)).equals(bytes)).toBe(true);
    expect(modelText(output)).not.toContain('could not be saved');
  });

  it('keeps other MCP output and reports attachment save failures without inventing a path', async () => {
    await writeFile(join(sessionDir, 'media'), 'not a directory');
    const output = await mcpResultToExecutableOutput({
      isError: false,
      content: [
        { type: 'text', text: 'The report was generated.' },
        { type: 'resource', resource: {
          uri: 'example://report', mimeType: 'application/pdf', blob: Buffer.from('%PDF-1.4').toString('base64'),
        } },
      ],
    }, 'mcp__example__report', { attachmentStore: store });
    expect(JSON.stringify(output.output)).toContain('The report was generated.');
    expect(output.isError).not.toBe(true);
    expect(modelText(output)).toContain('original attachment preservation is incomplete');
    expect(modelText(output)).not.toContain('Original attachment saved at:');
    expect(modelText(output)).toContain('Do not repeat the MCP call automatically');
  });

  it('reports malformed base64 instead of saving silently repaired bytes', async () => {
    const output = await mcpResultToExecutableOutput({
      isError: false,
      content: [{ type: 'resource', resource: {
        uri: 'example://report', blob: '%%%invalid base64===',
      } }],
    }, 'mcp__example__report', { attachmentStore: store });
    expect(modelText(output)).toContain('Invalid base64 attachment');
    expect(modelText(output)).not.toContain('Original attachment saved at:');
  });

  it('keeps unknown binary bytes and metadata accessible after reopening the session store', async () => {
    const bytes = Buffer.from([0, 255, 128, 65, 0]);
    const output = await mcpResultToExecutableOutput({
      isError: false,
      content: [{ type: 'resource', resource: { uri: 'example://unknown', blob: bytes.toString('base64') } }],
    }, 'mcp__example__unknown', { attachmentStore: store });
    const encodedPath = /Original attachment saved at: ("[^\n]+")/.exec(modelText(output))?.[1];
    expect(encodedPath).toBeDefined();
    const path = JSON.parse(encodedPath!) as string;
    expect(path.endsWith('.bin')).toBe(true);
    const fileId = path.split('/').at(-1)!.replace(/\.bin$/, '');
    const reopened = new SessionMediaStoreService(ix.get(ISessionContext), ix.get(IFileSystemStorageService), ix.get(IAtomicDocumentStore));
    const file = await reopened.open(fileId);
    expect(file?.mediaType).toBe('application/octet-stream');
    expect(file?.path).toBe(path);
    expect(Buffer.from((await reopened.read(fileId))!.data).equals(bytes)).toBe(true);
  });

  it.each([
    { provider: 'openai', kind: 'audio', mimeType: 'audio/wav' },
    { provider: 'anthropic', kind: 'audio', mimeType: 'audio/wav' },
    { provider: 'openai', kind: 'video', mimeType: 'video/mp4' },
  ])('keeps a small $kind original accessible after $provider lowering', async ({ provider, kind, mimeType }) => {
    const bytes = Buffer.alloc(1024, 0x63);
    const result = await mcpResultToExecutableOutput({
      isError: false,
      content: [kind === 'audio'
        ? { type: 'audio', mimeType, data: bytes.toString('base64') }
        : { type: 'resource', resource: { uri: 'example://video', mimeType, blob: bytes.toString('base64') } }],
    }, 'mcp__example__audio', { attachmentStore: store, providerType: provider });
    const content = renderToolResultForModel(result);
    const text = content.map((part) => part.type === 'text' ? part.text : '').join('\n');
    const encodedPath = /Original attachment saved at: ("[^\n]+")/.exec(text)?.[1];
    expect(encodedPath).toBeDefined();
    const path = JSON.parse(encodedPath!) as string;
    expect((await readFile(path)).equals(bytes)).toBe(true);
    const message: ToolMessage = { role: 'tool', toolCallId: 'audio', content };
    const wire = provider === 'openai'
      ? lowerOpenAI(message, {
          reasoningKey: 'reasoning_content',
          preserveThinking: false,
          toolMessageConversion: undefined,
        })
      : lowerAnthropic(message, providerImagePolicy().acceptedMimes);
    expect(JSON.stringify(wire)).toContain(JSON.stringify(encodedPath!).slice(1, -1));
    expect(JSON.stringify(wire)).not.toContain(bytes.toString('base64'));
  });

  it('provides a readable attachment reference when the backing store has no local path', async () => {
    const storage = new InMemoryStorageService();
    const memoryStore = new SessionMediaStoreService(ix.get(ISessionContext), storage, new JsonAtomicDocumentStore(storage));
    const bytes = Buffer.from('memory attachment');
    const result = await mcpResultToExecutableOutput({ isError: false, content: [{ type: 'resource', resource: {
      uri: 'example://memory', mimeType: 'text/plain', blob: bytes.toString('base64'),
    } }] }, 'mcp__example__memory', { attachmentStore: memoryStore });
    const text = modelText(result);
    expect(text).not.toContain('could not be saved');
    expect(text).not.toContain('Original attachment saved at:');
    const reference = JSON.parse(/Attachment reference: ("[^\n]+")/.exec(text)![1]!) as string;
    const file = await memoryStore.read(parseDaemonFileUrl(reference)!.fileId);
    expect(Buffer.from(file!.data).equals(bytes)).toBe(true);
  });

  it('preserves an unchanged image before older media is degraded', async () => {
    const bytes = Buffer.from(await new Jimp({ width: 32, height: 32, color: 0x3366ccff }).getBuffer('image/png'));
    const result = await mcpResultToExecutableOutput({
      isError: false,
      content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }],
    }, 'mcp__example__image', { attachmentStore: store });
    const content = renderToolResultForModel(result);
    const messages: Message[] = [
      { role: 'tool', toolCallId: 'image', content, toolCalls: [] },
      { role: 'user', toolCalls: [], content: [
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,bmV3' } },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,bmV3Mg==' } },
      ] },
    ];
    const degraded = degradeOlderMediaParts(messages, 2)[0]!;
    const text = degraded.content.map((part) => part.type === 'text' ? part.text : '').join('\n');
    expect(degraded.content.some((part) => part.type === 'image_url')).toBe(false);
    expect(text).not.toContain('Image compressed');
    const path = /Original attachment saved at: ("[^\n]+")/.exec(text)?.[1];
    expect(path).toBeDefined();
    expect((await readFile(JSON.parse(path!) as string)).equals(bytes)).toBe(true);
    expect(text).toContain('Attachment reference: "kimi-file://');
  });

  it('provides a session-relative path for an original preserved during image compression', async () => {
    const bytes = Buffer.from(await new Jimp({ width: 3600, height: 1800, color: 0x3366ccff }).getBuffer('image/png'));
    const result = await mcpResultToExecutableOutput({
      isError: false,
      content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }],
    }, 'mcp__example__image', { attachmentStore: store });
    const text = renderToolResultForModel(result).map((part) => part.type === 'text' ? part.text : '').join('\n');
    expect(text).toContain('Image compressed');
    const relative = /Session-relative attachment: ("[^\n]+")/.exec(text)?.[1];
    expect(relative).toBeDefined();
    expect((await readFile(join(sessionDir, JSON.parse(relative!) as string))).equals(bytes)).toBe(true);
  });

  it.each([
    ['text/csv', 'a,b\n1,2', '.csv'],
    ['text/html', '<p>hello</p>', '.html'],
    ['application/json', '{"a":1}', '.json'],
    ['application/example+json', '{"a":1}', '.json'],
    ['application/xml', '<item>one</item>', '.xml'],
    ['application/example+xml', '<item>one</item>', '.xml'],
    ['application/yaml', 'item: one', '.yaml'],
    ['application/example+yaml', 'item: one', '.yaml'],
    ['application/javascript', 'const item = 1;', '.js'],
    ['application/toml', 'item = 1', '.toml'],
    ['application/x-www-form-urlencoded', 'item=one', '.txt'],
    ['text/x-example', 'example text', '.txt'],
  ])('preserves %s blobs with a readable text extension', async (mimeType, body, extension) => {
    const bytes = Buffer.from(body);
    const result = await mcpResultToExecutableOutput({
      isError: false,
      content: [{ type: 'resource', resource: {
        uri: 'example://text', mimeType, blob: bytes.toString('base64'),
      } }],
    }, 'mcp__example__text', { attachmentStore: store });
    const encoded = /Original attachment saved at: ("[^\n]+")/.exec(modelText(result))?.[1];
    expect(encoded).toBeDefined();
    const path = JSON.parse(encoded!) as string;
    expect(path.endsWith(extension)).toBe(true);
    const saved = await readFile(path);
    expect(saved.equals(bytes)).toBe(true);
    expect(detectFileType(path, saved).kind).toBe('text');
  });

  it('saves uncompressed SVG as readable SVG text', async () => {
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
    const output = await mcpResultToExecutableOutput({
      isError: false,
      content: [{ type: 'resource', resource: {
        uri: 'example://drawing', mimeType: 'image/svg+xml', blob: bytes.toString('base64'),
      } }],
    }, 'mcp__example__drawing', { attachmentStore: store });
    const path = JSON.parse(/Original attachment saved at: ("[^\n]+")/.exec(modelText(output))![1]!) as string;
    expect(path.endsWith('.svg')).toBe(true);
    const saved = await readFile(path);
    expect(saved.equals(bytes)).toBe(true);
    expect(detectFileType(path, saved).kind).toBe('text');
  });

  it.each([true, false])('stops attachment persistence when cancellation is already triggered=%s', async (alreadyAborted) => {
    const controller = new AbortController();
    const reason = new Error('attachment import canceled');
    const storage = ix.get(IFileSystemStorageService);
    const writeStream = storage.writeStream.bind(storage);
    const writes = vi.spyOn(storage, 'writeStream').mockImplementation(async (scope, key, source, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort(reason);
      return writeStream(scope, key, source, options);
    });
    if (alreadyAborted) controller.abort(reason);
    await expect(mcpResultToExecutableOutput({
      isError: false,
      content: [1, 2, 3].map((i) => ({ type: 'resource', resource: {
        uri: `example://file/${String(i)}`, blob: Buffer.from(`file ${String(i)}`).toString('base64'),
      } })),
    }, 'mcp__example__files', { attachmentStore: store, signal: controller.signal })).rejects.toBe(reason);
    expect(writes).toHaveBeenCalledTimes(alreadyAborted ? 0 : 1);
  });

  it('keeps a same-size copy without re-reading the stream', async () => {
    await store.materialize(input());
    const again = await store.materialize(
      input({
        stream: () => {
          throw new Error('must not be read');
        },
      }),
    );
    expect(again).toBe(pathFor('f_1', '.mp4'));
    expect(await readFile(again!)).toEqual(BYTES);
  });

  it('overwrites a wrong-size copy', async () => {
    const target = await store.materialize(input());
    await writeFile(target!, 'xx');
    await store.materialize(input());
    expect(await readFile(target!)).toEqual(BYTES);
  });

  it('leaves no temporary storage entry when the stream fails', async () => {
    await expect(
      store.materialize(
        input({
          stream: () =>
            Readable.from(
              (async function* () {
                yield Buffer.from('partial');
                throw new Error('stream broke');
              })(),
            ),
        }),
      ),
    ).rejects.toMatchObject({ code: 'storage.io_failed' });
    const entries = await readdir(join(sessionDir, 'media')).catch(() => [] as string[]);
    expect(entries.filter((name) => name.includes('.tmp.'))).toEqual([]);
    expect(entries).not.toContain('f_1.mp4');
  });

  it('derives the extension from the name, then the MIME fallback', async () => {
    expect(await store.materialize(input())).toBe(pathFor('f_1', '.mp4'));
    expect(await store.materialize(input({ fileId: 'f_2', name: 'noext' }))).toBe(
      pathFor('f_2', '.mp4'),
    );
    expect(await store.materialize(input({ fileId: 'f_3', name: 'noext', mimeType: 'odd/type' }))).toBe(
      pathFor('f_3', '.bin'),
    );
  });

  it('reads canonical bytes independently from the daemon file store', async () => {
    await store.materialize(input());
    await expect(store.read('f_1')).resolves.toEqual({
      data: BYTES,
      name: 'f_1.mp4',
    });
  });

  it('opens canonical media with its persisted download metadata', async () => {
    await store.materialize(input({ name: 'original clip.mp4', mimeType: 'video/mp4' }));

    const file = await store.open('f_1');

    expect(file).toMatchObject({
      path: join(sessionDir, 'media', 'f_1.mp4'),
      name: 'original clip.mp4',
      mediaType: 'video/mp4',
      size: BYTES.length,
    });
    expect(file === undefined ? undefined : Buffer.from(await collect(file.stream()))).toEqual(BYTES);
  });

  it('streams only the requested canonical byte range', async () => {
    await store.materialize(input());

    const file = await store.open('f_1');

    expect(
      file === undefined
        ? undefined
        : Buffer.from(await collect(file.stream({ start: 2, end: 6 }))),
    ).toEqual(BYTES.subarray(2, 7));
  });

  it('resolves the display path from the canonical copy by file id alone', async () => {
    const target = await store.materialize(input());
    await expect(store.resolveDisplayPath('f_1')).resolves.toBe(target);
    await expect(store.resolveDisplayPath('f_missing')).resolves.toBeUndefined();
  });

  it('finds an extensionless canonical copy by listing', async () => {
    const target = await store.materialize(input({ name: 'noext', mimeType: 'odd/type' }));
    expect(target).toBe(pathFor('f_1', '.bin'));
    const extless = pathFor('f_1', '');
    await rm(target!);
    await writeFile(extless, BYTES);
    await expect(store.resolveDisplayPath('f_1')).resolves.toBe(extless);
  });

  it('skips in-progress atomic temp siblings when resolving by id', async () => {
    await mkdir(join(sessionDir, 'media'), { recursive: true });
    await writeFile(join(sessionDir, 'media', 'f_1.mp4.tmp.1234.deadbeef'), 'partial');
    await expect(store.resolveDisplayPath('f_1')).resolves.toBeUndefined();
    await expect(store.read('f_1')).resolves.toBeUndefined();
    await expect(store.open('f_1')).resolves.toBeUndefined();

    const target = await store.materialize(input());
    await expect(store.resolveDisplayPath('f_1')).resolves.toBe(target);
    await expect(store.read('f_1')).resolves.toEqual({ data: BYTES, name: 'f_1.mp4' });
  });

  it('never turns a non-upload id into a storage key (path traversal guard)', async () => {
    const evil = '../../../../etc/passwd';
    expect(store.pathFor(evil, '')).toBeUndefined();
    expect(store.pathFor(evil, '.png')).toBeUndefined();
    await expect(store.read(evil)).resolves.toBeUndefined();
    await expect(store.materialize(input({ fileId: evil }))).resolves.toBeUndefined();
    await expect(store.resolveDisplayPath(evil)).resolves.toBeUndefined();
    expect(store.pathFor('f_1', '.mp4')).toBe(join(sessionDir, 'media', 'f_1.mp4'));
  });
});

it('retains canonical bytes without inventing a path for a non-filesystem backend', async () => {
  const disposables = new DisposableStore();
  const ix = createServices(disposables, {
    strict: true,
    additionalServices: (reg) => {
      reg.defineInstance(ISessionContext, makeSessionContext({
        sessionId: 's1',
        workspaceId: 'w1',
        sessionDir: '/unused',
        sessionScope: 'sessions/w1/s1',
        cwd: '/tmp',
      }));
      reg.defineInstance(IFileSystemStorageService, new InMemoryStorageService());
      reg.define(IAtomicDocumentStore, JsonAtomicDocumentStore);
      reg.define(ISessionMediaStore, SessionMediaStoreService);
    },
  });
  const store = ix.get(ISessionMediaStore);
  await expect(store.materialize({
    fileId: 'f_1',
    size: BYTES.length,
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    stream: streamOf(BYTES),
  })).resolves.toBeUndefined();
  const canonical = await store.read('f_1');
  expect(canonical?.name).toBe('f_1.mp4');
  expect(canonical === undefined ? undefined : Buffer.from(canonical.data)).toEqual(BYTES);
  expect((await store.open('f_1'))?.path).toBeUndefined();
  disposables.dispose();
});

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}
