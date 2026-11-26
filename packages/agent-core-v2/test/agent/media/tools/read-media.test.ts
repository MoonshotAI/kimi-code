import * as posixPath from 'node:path/posix';

import type { ModelCapability, LlmFiles } from '@moonshot-ai/core/llm/request';
import type { ContentPart } from '@moonshot-ai/core/llm/message';
import { mediaUrlOf } from '@moonshot-ai/core/llm/protocol/kit/media';
import { Jimp } from 'jimp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Event } from '#/_base/event';
import type { IEventDispatcher } from '#/state/eventDispatcher';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { LOCAL_ENVIRONMENT_ID, type Environment } from '#/environment/environment';
import type { IAgentEnvironmentBindingService } from '#/agent/environmentBinding/environmentBinding';
import { stubAgentEnvironment } from '../../../environment/stubs';
import type { ITelemetryService, TelemetryProperties } from '#/app/telemetry/telemetry';
import { ReadInputSchema, type ReadInput } from '#/agent/tools/os/read/read';
import { ReadTool } from '#/agent/tools/os/read/readTool';
import type { VideoUploader } from '#/llm-adapter/model/media';
import {
  MAX_IMAGE_DECODE_BYTES,
  setConfiguredReadImageByteBudget,
} from '#/agent/media/image-compress';
import { createVideoUploader } from '#/agent/media/videoUpload';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { SessionMediaStoreService } from '#/agent/media/sessionMediaStoreService';
import { AgentMediaResolverService } from '#/agent/media/mediaResolverService';
import type { IFileService } from '#/app/file/fileService';
import type { IBlobStore } from '#/persistence/interface/blobStore';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocolAdapterRegistry';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import { AgentStateService } from '#/agent/state/agentStateService';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import type { Model } from '#/llm-adapter/model/catalog';
import type { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import type { IAgentLoopService } from '#/agent/loop/loop';
import { sniffImageDimensions } from '#/agent/media/file-type';
import { stubWorkspaceContext } from '../../../session/workspaceContext/stub-workspace-context';
import { stubToolResultTruncationService } from '../../toolResultTruncation/stubs';
import { stubConfigService } from '../../../app/config/stubs';

const PNG_WIDTH = 1920;
const PNG_HEIGHT = 1080;

afterEach(() => {
  setConfiguredReadImageByteBudget(undefined);
});

function pngBuffer(width = PNG_WIDTH, height = PNG_HEIGHT): Buffer {
  const buf = Buffer.alloc(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function mp4Buffer(): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp'),
    Buffer.from('mp42'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('mp42isom'),
  ]);
}

function withExifOrientation(jpeg: Uint8Array, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);
  const exifBody = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1Header = Buffer.alloc(4);
  app1Header.writeUInt16BE(0xff_e1, 0);
  app1Header.writeUInt16BE(exifBody.length + 2, 2);
  return Buffer.concat([
    Buffer.from(jpeg.subarray(0, 2)),
    app1Header,
    exifBody,
    Buffer.from(jpeg.subarray(2)),
  ]);
}

interface TelemetryRecord {
  readonly event: string;
  readonly properties: Readonly<Record<string, unknown>> | undefined;
}

function recordingTelemetry(records: TelemetryRecord[]): ITelemetryService {
  const telemetry: ITelemetryService = {
    _serviceBrand: undefined,
    track(event, properties) {
      records.push({ event, properties });
    },
    track2(event, properties) {
      records.push({ event, properties: properties as TelemetryProperties });
    },
    withContext: () => telemetry,
    setContext: () => {},
    getContext: () => ({}),
    addAppender: () => ({ dispose: () => {} }),
    removeAppender: () => {},
    setEnabled: () => {},
    flush: async () => {},
    shutdown: async () => {},
  };
  return telemetry;
}

function capabilities(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    image_in: true,
    video_in: true,
    audio_in: false,
    thinking: false,
    tool_use: true,
    ...overrides,
  };
}

interface FakeFile {
  readonly data: Buffer;
  readonly size?: number;
}

function createTestFs(files: Record<string, FakeFile>): IHostFileSystem {
  const lookup = (path: string): FakeFile | undefined => files[path];
  const stat = vi.fn(async (path: string) => {
    const file = lookup(path);
    if (file === undefined) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return {
      isFile: true,
      isDirectory: false,
      size: file.size ?? file.data.length,
    };
  });
  const readBytes = vi.fn(async (path: string, n?: number) => {
    const data = lookup(path)?.data ?? Buffer.alloc(0);
    return n === undefined ? data : data.subarray(0, n);
  });
  const readFileHead = vi.fn(async (path: string, maxBytes: number) => {
    const fileStat = await stat(path);
    return { stat: fileStat, bytes: await readBytes(path, maxBytes) };
  });
  const readLines = vi.fn(async function* (path: string) {
    const text = (lookup(path)?.data ?? Buffer.alloc(0)).toString('utf8');
    if (text.length > 0) yield text;
  });
  return {
    readBytes,
    readFileHead,
    readLines,
    stat,
  } as unknown as IHostFileSystem;
}

function createTestEnv(): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: '/home',
    ready: Promise.resolve(),
  };
}

function environmentFor(fs: IHostFileSystem, env: IHostEnvironment = createTestEnv()): IAgentEnvironmentService {
  const environment = {
    identity: { environmentId: 'local', generation: 'test' },
    capabilities: new Set(['fs'] as const),
    host: env,
    path: posixPath,
    workspace: { mapRoots: (roots: { workDir: string; additionalDirs?: readonly string[] }) => roots },
    fs,
    status: 'ready',
    onDidChangeStatus: () => ({ dispose: () => {} }),
    dispose: () => {},
  } as unknown as Environment;
  return stubAgentEnvironment(environment, {
    isAvailable: (required = []) => required.every((capability) => environment.capabilities.has(capability)),
  });
}

function testMediaStore(): ISessionMediaStore {
  const storage = new InMemoryStorageService();
  return new SessionMediaStoreService(
    makeSessionContext({
      sessionId: 'session',
      workspaceId: 'workspace',
      cwd: '/workspace',
      sessionDir: '/session',
      sessionScope: 'session',
    }),
    storage,
    new JsonAtomicDocumentStore(storage),
  );
}

function makeToolFromFs(
  fs: IHostFileSystem,
  telemetry?: ITelemetryService,
  attachmentStore: ISessionMediaStore = testMediaStore(),
  modelCaps: ModelCapability = capabilities(),
): ReadTool {
  return new ReadTool(
    environmentFor(fs),
    stubWorkspaceContext('/workspace'),
    { catalog: { getSkillRoots: () => [] } } as unknown as ISessionSkillCatalog,
    stubToolResultTruncationService(),
    stubConfigService(),
    { getModelCapabilities: () => modelCaps } as unknown as IAgentLoopService,
    attachmentStore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    telemetry,
  );
}

function makeTool(
  files: Record<string, FakeFile>,
  telemetry?: ITelemetryService,
  attachmentStore: ISessionMediaStore = testMediaStore(),
  modelCaps: ModelCapability = capabilities(),
): ReadTool {
  return makeToolFromFs(createTestFs(files), telemetry, attachmentStore, modelCaps);
}

async function execute(
  tool: ReadTool,
  args: ReadInput,
): Promise<ExecutableToolResult> {
  const execution = await tool.resolveExecution(args);
  if (!('execute' in execution)) {
    return execution;
  }
  const ctx: ExecutableToolContext = {
    turnId: 1,
    toolCallId: 'call_media',
    signal: new AbortController().signal,
  };
  return execution.execute(ctx);
}

function outputParts(result: ExecutableToolResult): ContentPart[] {
  expect(result.isError).toBeFalsy();
  expect(Array.isArray(result.output)).toBe(true);
  return result.output as ContentPart[];
}

function mediaUrl(part: ContentPart | undefined): string {
  if (part === undefined || (part.type !== 'image_url' && part.type !== 'audio_url' && part.type !== 'video_url')) {
    throw new Error('expected media content');
  }
  return mediaUrlOf(part);
}

function noteText(result: ExecutableToolResult): string {
  expect(typeof result.note).toBe('string');
  return result.note as string;
}

describe('ReadTool — media files', () => {
  it('exposes Read without crop or full_resolution parameters and scopes read access by path', async () => {
    const tool = makeTool({ '/workspace/sample.png': { data: pngBuffer() } });

    expect(tool.name).toBe('Read');
    expect(ReadInputSchema.safeParse({ path: '/workspace/sample.png' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
    });
    expect(tool.parameters['properties']).not.toHaveProperty('region');
    expect(tool.parameters['properties']).not.toHaveProperty('full_resolution');

    const execution = (await tool.resolveExecution({ path: '/workspace/sample.png' })) as Extract<
      ToolExecution,
      { execute: unknown }
    >;
    expect(execution.accesses).toEqual(ToolAccesses.readFile('/workspace/sample.png'));
    expect(execution.approvalRule).toBe('Read(/workspace/sample.png)');
  });

  it('describes text, image, and video support', () => {
    const description = makeTool({}).description;
    expect(description).toContain('image');
    expect(description).toContain('video');
  });

  it('rejects empty paths', async () => {
    const result = await execute(makeTool({}), { path: '' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('File path cannot be empty');
  });

  it('reads text files directly instead of rejecting them', async () => {
    const result = await execute(
      makeTool({ '/workspace/note.txt': { data: Buffer.from('hello world\n') } }),
      { path: '/workspace/note.txt' },
    );
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('1\thello world');
  });

  it('rejects text pagination parameters on image and video files', async () => {
    const tool = makeTool({
      '/workspace/sample.png': { data: pngBuffer() },
      '/workspace/clip.mp4': { data: mp4Buffer() },
    });
    const imageWithLines = await execute(tool, { path: '/workspace/sample.png', n_lines: 10 });
    expect(imageWithLines.isError).toBe(true);
    expect(imageWithLines.output).toContain('text files');

    const videoWithOffset = await execute(tool, { path: '/workspace/clip.mp4', line_offset: 2 });
    expect(videoWithOffset.isError).toBe(true);
    expect(videoWithOffset.output).toContain('text files');
  });

  it('rejects unsupported binary formats', async () => {
    const result = await execute(
      makeTool({ '/workspace/archive.zip': { data: Buffer.from([0x50, 0x4b, 0x03, 0x04]) } }),
      { path: '/workspace/archive.zip' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('not readable as UTF-8 text');
  });

  it('returns a text/image/text wrap plus a <system> note for PNG files', async () => {
    const result = await execute(makeTool({ '/workspace/sample.png': { data: pngBuffer() } }), {
      path: '/workspace/sample.png',
    });

    const systemText = noteText(result);
    expect(systemText).toMatch(/^<system>.*<\/system>$/s);
    expect(systemText).toContain('Mime type: image/png');
    expect(systemText).toContain(`Original dimensions: ${PNG_WIDTH}x${PNG_HEIGHT}`);
    expect(systemText).toMatch(/relative coordinates first/i);
    expect(systemText).toMatch(/read the result back/i);

    const parts = outputParts(result);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: '<image path="/workspace/sample.png">' });
    expect(parts[1]?.type).toBe('image_url');
    expect(mediaUrl(parts[1])).toContain('kimi-file://');
    expect(parts[2]).toEqual({ type: 'text', text: '</image>' });
  });

  it('downsamples large images without advertising region readback', async () => {
    const big = Buffer.from(
      await new Jimp({ width: 2200, height: 2200, color: 0x3366ccff }).getBuffer('image/png'),
    );
    expect(sniffImageDimensions(big)).toEqual({ width: 2200, height: 2200 });

    const store = testMediaStore();
    const result = await execute(
      makeTool({ '/workspace/big.png': { data: big } }, undefined, store),
      { path: '/workspace/big.png' },
    );

    const systemText = noteText(result);
    expect(systemText).toContain('2200x2200');
    expect(systemText).toContain(`${String(big.length)} bytes`);
    expect(systemText).toMatch(/The attached image was downsampled to 2000x2000/);
    expect(systemText).toMatch(/fine detail/i);
    expect(systemText).not.toContain('region parameter');

    const stored = await store.get(mediaUrl(outputParts(result)[1]));
    expect(stored?.mimeType).toMatch(/^image\//);
    const dims = sniffImageDimensions(Buffer.from(stored!.bytes));
    expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(2000);
  });

  it('returns an actionable error when compression cannot meet the byte budget', async () => {
    const oversized = Buffer.concat([pngBuffer(), Buffer.alloc(256 * 1024, 1)]);

    const result = await execute(
      makeTool({ '/workspace/oversized.png': { data: oversized } }),
      { path: '/workspace/oversized.png' },
    );

    expect(result).toMatchObject({
      isError: true,
      output:
        'Image is too large to send safely after compression (262168 bytes; limit 262144 bytes and 2000px on the longest edge). ' +
        'The original image was not sent to the model. Do not retry the same file unchanged. ' +
        'Use Bash or an available image-processing tool to create a smaller copy within both limits, ' +
        'then call Read on the smaller copy.',
    });
  });

  it('returns an actionable error when compression cannot meet the pixel budget', async () => {
    const result = await execute(
      makeTool({ '/workspace/wide.png': { data: pngBuffer(2001, 1000) } }),
      { path: '/workspace/wide.png' },
    );

    expect(result).toMatchObject({
      isError: true,
      output:
        'Image is too large to send safely after compression (24 bytes; limit 262144 bytes and 2000px on the longest edge). ' +
        'The original image was not sent to the model. Do not retry the same file unchanged. ' +
        'Use Bash or an available image-processing tool to create a smaller copy within both limits, ' +
        'then call Read on the smaller copy.',
    });
  });

  it('reads only the sniff header when the image exceeds the safe decode allocation', async () => {
    const fs = createTestFs({
      '/workspace/huge.png': { data: pngBuffer(), size: MAX_IMAGE_DECODE_BYTES + 1 },
    });
    const tool = makeToolFromFs(fs);

    const result = await execute(tool, { path: '/workspace/huge.png' });

    expect(result).toMatchObject({
      isError: true,
      output:
        'Image is too large to send safely after compression (67108865 bytes; limit 262144 bytes and 2000px on the longest edge). ' +
        'The original image was not sent to the model. Do not retry the same file unchanged. ' +
        'Use Bash or an available image-processing tool to create a smaller copy within both limits, ' +
        'then call Read on the smaller copy.',
    });
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledOnce();
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledWith('/workspace/huge.png', 512);
  });

  it('does not treat the decode allocation cap as a hard limit when the configured delivery budget accepts the file', async () => {
    setConfiguredReadImageByteBudget(70 * 1024 * 1024);
    const fs = createTestFs({
      '/workspace/large.png': { data: pngBuffer(), size: MAX_IMAGE_DECODE_BYTES + 1 },
    });
    const tool = makeToolFromFs(fs);

    const result = await execute(tool, { path: '/workspace/large.png' });

    expect(result.isError).toBe(false);
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fs.readBytes)).toHaveBeenLastCalledWith('/workspace/large.png', undefined);
  });

  it('does not claim downsampling for an image sent untouched', async () => {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000030000000408020000003a' +
        '63dc1c0000001949444154789c63606060f8cf80019aa0a8a020' +
        '00000000ffff03000c1d03014b0000000049454e44ae426082',
      'hex',
    );
    const result = await execute(makeTool({ '/workspace/small.png': { data: png } }), {
      path: '/workspace/small.png',
    });
    expect(noteText(result)).not.toMatch(/downsampled/i);
  });

  it('reports an EXIF-rotated original in the decoded coordinate space', async () => {
    const portrait = withExifOrientation(
      new Uint8Array(
        await new Jimp({ width: 2200, height: 1100, color: 0x3366ccff }).getBuffer('image/jpeg', {
          quality: 90,
        }),
      ),
      6,
    );
    const result = await execute(makeTool({ '/workspace/portrait.jpg': { data: portrait } }), {
      path: '/workspace/portrait.jpg',
    });

    const systemText = noteText(result);
    expect(systemText).toContain('Original dimensions: 1100x2200');
    expect(systemText).toMatch(/downsampled to 1000x2000/);
  }, 15000);

  it('reports display-space dimensions for an EXIF-rotated image sent untouched', async () => {
    const portrait = withExifOrientation(
      new Uint8Array(
        await new Jimp({ width: 120, height: 80, color: 0x3366ccff }).getBuffer('image/jpeg', {
          quality: 90,
        }),
      ),
      6,
    );
    const result = await execute(makeTool({ '/workspace/portrait.jpg': { data: portrait } }), {
      path: '/workspace/portrait.jpg',
    });

    const systemText = noteText(result);
    expect(systemText).toContain('Original dimensions: 80x120');
    expect(systemText).not.toMatch(/downsampled/i);
  });

  it('emits image_compress telemetry tagged read_media', async () => {
    const records: TelemetryRecord[] = [];
    const big = Buffer.from(
      await new Jimp({ width: 2200, height: 1100, color: 0x3366ccff }).getBuffer('image/png'),
    );
    const tool = makeTool(
      { '/workspace/big.png': { data: big } },
      recordingTelemetry(records),
    );

    await execute(tool, { path: '/workspace/big.png' });
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toBe('image_compress');
    expect(records[0]!.properties?.['source']).toBe('read_media');
    expect(records[0]!.properties?.['outcome']).toBe('compressed');
  });

  it('wraps a video as a kimi-file reference', async () => {
    const result = await execute(makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } }), {
      path: '/workspace/clip.mp4',
    });

    const systemText = noteText(result);
    expect(systemText).toMatch(/^<system>.*<\/system>$/s);
    expect(systemText).toContain('video/mp4');

    const parts = outputParts(result);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: '<video path="/workspace/clip.mp4">' });
    expect(parts[1]?.type).toBe('video_url');
    expect(mediaUrl(parts[1])).toContain('kimi-file://');
    expect(parts[2]).toEqual({ type: 'text', text: '</video>' });
  });

  it('stores a video as a kimi-file part without uploading during execution', async () => {
    const store = testMediaStore();
    const put = vi.spyOn(store, 'put');
    const result = await execute(
      makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } }, undefined, store),
      { path: '/workspace/clip.mp4' },
    );

    const parts = outputParts(result);
    expect(put).toHaveBeenCalledOnce();
    expect(mediaUrl(parts[1])).toMatch(/^kimi-file:\/\//);
    expect(put.mock.calls[0]?.[0]).toMatchObject({ mimeType: 'video/mp4', filename: 'clip.mp4' });
  });

  it('passes the execution abort signal to media storage', async () => {
    const controller = new AbortController();
    const store = testMediaStore();
    const put = vi.spyOn(store, 'put').mockImplementation(async (input) =>
      new Promise<string>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => {
          reject(new Error('storage cancelled'));
        }, { once: true });
      }),
    );
    const tool = makeTool(
      { '/workspace/clip.mp4': { data: mp4Buffer() } },
      undefined,
      store,
    );
    const execution = await tool.resolveExecution({ path: '/workspace/clip.mp4' });
    if (!('execute' in execution)) throw new Error('Expected an executable tool call');

    const pending = execution.execute({ turnId: 1, toolCallId: 'call_media', signal: controller.signal });
    await vi.waitFor(() => {
      expect(put).toHaveBeenCalledOnce();
    });
    controller.abort();

    expect(put.mock.calls[0]?.[0].signal).toBe(controller.signal);
    await expect(pending).rejects.toThrow('storage cancelled');
  });

  it('reads stored video bytes and metadata for deferred resolution', async () => {
    const store = testMediaStore();
    const result = await execute(
      makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } }, undefined, store),
      { path: '/workspace/clip.mp4' },
    );

    const stored = await store.get(mediaUrl(outputParts(result)[1]));
    expect(stored?.mimeType).toBe('video/mp4');
    expect(stored?.filename).toBe('clip.mp4');
    expect(Buffer.from(stored!.bytes)).toEqual(mp4Buffer());
  });

  it('defers video upload and video_upload telemetry to the next LLM request', async () => {
    const records: TelemetryRecord[] = [];
    const telemetry = recordingTelemetry(records);
    const store = testMediaStore();
    const result = await execute(
      makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } }, telemetry, store),
      { path: '/workspace/clip.mp4' },
    );
    expect(records.filter((record) => record.event === 'video_upload')).toEqual([]);

    const upload = vi.fn(async () => ({ url: 'ms://prov-1', id: 'prov-1' }));
    const files: LlmFiles = { kinds: new Set(['video']), upload };
    const model: Model = {
      id: 'm',
      aliases: [],
      protocol: 'openai',
      spec: {
        provider: 'kimi',
        name: 'stub',
        capability: capabilities(),
        thinking: { alwaysThinking: false },
        maxContextSize: 1000,
      },
      endpoint: { baseUrl: 'https://example.test', headers: {} },
      providerName: 'p',
      providerType: 'kimi',
    };
    const resolver = new AgentMediaResolverService(
      {} as IFileService,
      { get: async () => undefined, put: async () => {}, has: async () => false } as unknown as IBlobStore,
      telemetry,
      new AgentStateService(),
      store,
      { dispatch: async () => {} } as unknown as IEventDispatcher,
      makeAgentScopeContext({ agentId: 'main', agentScope: '' }),
      {
        _serviceBrand: undefined,
        current: { environmentId: LOCAL_ENVIRONMENT_ID },
        onDidChange: Event.None,
        bind: () => {
          throw new Error('unused');
        },
      } as IAgentEnvironmentBindingService,
    );
    const resolved = await resolver.resolve(
      [{ role: 'tool', toolCallId: 'call_media', content: outputParts(result) }],
      model,
      new ProtocolAdapterRegistry().request(model).with({ endpoint: { files } }),
    );

    expect(upload).toHaveBeenCalledOnce();
    expect(resolved[0]?.content[1]).toEqual({
      type: 'video_url',
      videoUrl: { url: 'ms://prov-1', id: 'prov-1' },
    });
    expect(records.filter((record) => record.event === 'video_upload')).toEqual([
      expect.objectContaining({
        event: 'video_upload',
        properties: expect.objectContaining({ outcome: 'success' }),
      }),
    ]);
  });

  it('rejects empty files', async () => {
    const result = await execute(
      makeTool({ '/workspace/sample.png': { data: pngBuffer(), size: 0 } }),
      { path: '/workspace/sample.png' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('is empty');
  });

  it('rejects files larger than the media limit', async () => {
    const oversized = 101 * 1024 * 1024;
    const result = await execute(
      makeTool({ '/workspace/sample.png': { data: pngBuffer(), size: oversized } }),
      { path: '/workspace/sample.png' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('exceeds the maximum');
  });
});

describe('createVideoUploader', () => {
  const uploadResult = {
    type: 'video_url' as const,
    videoUrl: { url: 'https://example.com/uploaded.mp4' },
  };
  const input = { data: new Uint8Array(2048), mimeType: 'video/mp4', filename: 'clip.mp4' };

  function modelWith(uploadVideo: VideoUploader | undefined): VideoUploader | undefined {
    return uploadVideo;
  }

  it('returns undefined when the model does not support video upload', () => {
    expect(createVideoUploader(undefined)).toBeUndefined();
  });

  it('binds uploadVideo without telemetry', async () => {
    const uploadVideo = vi.fn().mockResolvedValue(uploadResult);
    const uploader = createVideoUploader(modelWith(uploadVideo));
    await expect(uploader!(input)).resolves.toEqual(uploadResult);
    expect(uploadVideo).toHaveBeenCalledWith(input, undefined);
  });

  it('reports video_upload telemetry on success', async () => {
    const records: TelemetryRecord[] = [];
    const uploader = createVideoUploader(modelWith(vi.fn().mockResolvedValue(uploadResult)), {
      client: recordingTelemetry(records),
      props: { model: 'example-model', protocol: 'kimi' },
    });
    await expect(uploader!(input)).resolves.toEqual(uploadResult);
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toBe('video_upload');
    expect(records[0]!.properties).toMatchObject({
      outcome: 'success',
      mime_type: 'video/mp4',
      size_bytes: 2048,
      model: 'example-model',
      protocol: 'kimi',
    });
    expect(records[0]!.properties?.['duration_ms']).toEqual(expect.any(Number));
  });

  it('reports an error outcome with the error type and rethrows', async () => {
    const records: TelemetryRecord[] = [];
    const failure = new TypeError('upload exploded');
    const uploader = createVideoUploader(modelWith(vi.fn().mockRejectedValue(failure)), {
      client: recordingTelemetry(records),
    });
    await expect(uploader!(input)).rejects.toBe(failure);
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toBe('video_upload');
    expect(records[0]!.properties).toMatchObject({
      outcome: 'error',
      error_type: 'TypeError',
      mime_type: 'video/mp4',
      size_bytes: 2048,
    });
  });

  it('never lets a throwing telemetry client break the upload', async () => {
    const throwing = {
      ...recordingTelemetry([]),
      track2: () => {
        throw new Error('sink down');
      },
    } as ITelemetryService;
    const uploader = createVideoUploader(modelWith(vi.fn().mockResolvedValue(uploadResult)), {
      client: throwing,
    });
    await expect(uploader!(input)).resolves.toEqual(uploadResult);
  });

  function heicBytes(): Buffer {
    return Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
      0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
    ]);
  }

  function ftypBytes(brand: string): Buffer {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(24, 0);
    buf.write('ftyp', 4, 'latin1');
    buf.write(brand, 8, 'latin1');
    buf.write(brand, 16, 'latin1');
    return buf;
  }

  it('stores HEIC untouched during execution for deferred resolution', async () => {
    const store = testMediaStore();
    const result = await execute(makeTool({ '/workspace/photo.heic': { data: heicBytes() } }, undefined, store), {
      path: '/workspace/photo.heic',
    });

    expect(result.isError).toBeFalsy();
    const stored = await store.get(mediaUrl(outputParts(result)[1]));
    expect(stored?.mimeType).toBe('image/heic');
    expect(Buffer.from(stored!.bytes)).toEqual(heicBytes());
    expect(noteText(result)).toContain('Mime type: image/heic.');
  });

  it('preserves a HEIC above the read budget for deferred inline resolution', async () => {
    const heic = Buffer.concat([heicBytes(), Buffer.alloc(5 * 1024 * 1024, 1)]);
    const store = testMediaStore();
    const result = await execute(makeTool({ '/workspace/photo.heic': { data: heic } }, undefined, store), {
      path: '/workspace/photo.heic',
    });

    expect(result.isError).toBeFalsy();
    const stored = await store.get(mediaUrl(outputParts(result)[1]));
    expect(stored!.bytes.byteLength).toBe(heic.byteLength);
    expect(Buffer.compare(Buffer.from(stored!.bytes), heic)).toBe(0);
  });

  it('puts AVIF without consulting a provider-accepted set during execution', async () => {
    const store = testMediaStore();
    const result = await execute(makeTool({ '/workspace/photo.avif': { data: ftypBytes('avif') } }, undefined, store), {
      path: '/workspace/photo.avif',
    });

    expect(result.isError).toBeFalsy();
    const stored = await store.get(mediaUrl(outputParts(result)[1]));
    expect(stored?.mimeType).toBe('image/avif');
  });
});
