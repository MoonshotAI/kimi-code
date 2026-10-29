import * as posixPath from 'node:path/posix';
import { Readable } from 'node:stream';

import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/llm-adapter/contract/capability';
import type { ContentPart } from '#human/llm/message';
import { mediaUrlOf } from '#human/llm/protocol/kit/media';
import { Jimp } from 'jimp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Emitter } from '#/_base/event';
import { OrderedHookSlot } from '#/hooks';
import type { IEventDispatcher } from '#/state/eventDispatcher';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import type { Environment } from '#/environment/environment';
import { stubAgentEnvironment } from '../../../environment/stubs';
import type { ITelemetryService, TelemetryProperties } from '#/app/telemetry/telemetry';
import {
  ReadMediaFileInputSchema,
  type ReadMediaFileInput,
} from '#/agent/tools/read-media-file/read-media-file';
import { ReadMediaFileTool } from '#/agent/tools/read-media-file/readMediaFileTool';
import type { VideoUploader } from '#/llm-adapter/model/media';
import {
  MAX_IMAGE_DECODE_BYTES,
  setConfiguredReadImageByteBudget,
} from '#/agent/media/image-compress';
import { createVideoUploader, registerMediaTools } from '#/agent/media/registerMediaTools';
import { AgentMediaToolsRegistrar } from '#/agent/media/mediaToolsRegistrar';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { SessionMediaStoreService } from '#/agent/media/sessionMediaStoreService';
import { AgentMediaResolverService } from '#/agent/media/mediaResolverService';
import type { IFileService } from '#/app/file/fileService';
import type { IBlobStore } from '#/persistence/interface/blobStore';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocolAdapterRegistry';
import type { LlmFiles } from '#human/llm/request';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import { AgentStateService } from '#/agent/state/agentStateService';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { EventBusService } from '#/app/event/eventBusService';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import type { Model } from '#/llm-adapter/model/catalog';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { WorkspaceConfig } from '#/tool/path-access';
import { sniffImageDimensions } from '#/agent/media/file-type';
import { stubAgentContext } from '../../agentContext/stubs';

const WORKSPACE: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: [] };

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
    max_context_tokens: 0,
    ...overrides,
  };
}

interface FakeFile {
  readonly data: Buffer;
  readonly size?: number;
}

function createTestFs(files: Record<string, FakeFile>): IHostFileSystem {
  const lookup = (path: string): FakeFile | undefined => files[path];
  return {
    readBytes: vi.fn(async (path: string, n?: number) => {
      const data = lookup(path)?.data ?? Buffer.alloc(0);
      return n === undefined ? data : data.subarray(0, n);
    }),
    stat: vi.fn(async (path: string) => {
      const file = lookup(path);
      return {
        isFile: true,
        isDirectory: false,
        size: file?.size ?? file?.data.length ?? 0,
      };
    }),
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

function makeTool(
  files: Record<string, FakeFile>,
  telemetry?: ITelemetryService,
  attachmentStore: ISessionMediaStore = testMediaStore(),
): ReadMediaFileTool {
  return new ReadMediaFileTool(
    environmentFor(createTestFs(files)),
    WORKSPACE,
    attachmentStore,
    telemetry,
  );
}

async function execute(
  tool: ReadMediaFileTool,
  args: ReadMediaFileInput,
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

describe('ReadMediaFileTool', () => {
  it('has name, parameters, and a path-scoped read access', async () => {
    const tool = makeTool({ '/workspace/sample.png': { data: pngBuffer() } });

    expect(tool.name).toBe('ReadMediaFile');
    expect(ReadMediaFileInputSchema.safeParse({ path: '/workspace/sample.png' }).success).toBe(true);
    expect(
      ReadMediaFileInputSchema.safeParse({
        path: '/workspace/sample.png',
        region: { x: 0, y: 0, width: 10, height: 10 },
      }).success,
    ).toBe(true);
    expect(
      ReadMediaFileInputSchema.safeParse({
        path: '/workspace/sample.png',
        region: { x: -1, y: 0, width: 10, height: 10 },
      }).success,
    ).toBe(false);
    expect(
      ReadMediaFileInputSchema.safeParse({
        path: '/workspace/sample.png',
        region: { x: 0, y: 0, width: 0, height: 10 },
      }).success,
    ).toBe(false);
    expect(
      ReadMediaFileInputSchema.safeParse({
        path: '/workspace/sample.png',
        full_resolution: true,
      }).success,
    ).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
    });

    const execution = (await tool.resolveExecution({ path: '/workspace/sample.png' })) as Extract<
      ToolExecution,
      { execute: unknown }
    >;
    expect(execution.accesses).toEqual(ToolAccesses.readFile('/workspace/sample.png'));
    expect(execution.approvalRule).toBe('ReadMediaFile(/workspace/sample.png)');
  });

  it('describes media support without model capability claims', () => {
    const description = makeTool({}).description;
    expect(description).toContain('image and video files');
    expect(description).not.toContain('current model');
  });

  it('rejects empty paths', async () => {
    const result = await execute(makeTool({}), { path: '' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('File path cannot be empty');
  });

  it('redirects text files to the Read tool', async () => {
    const result = await execute(
      makeTool({ '/workspace/note.txt': { data: Buffer.from('hello world') } }),
      { path: '/workspace/note.txt' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Use Read');
  });

  it('rejects unsupported binary formats', async () => {
    const result = await execute(
      makeTool({ '/workspace/archive.zip': { data: Buffer.from([0x50, 0x4b, 0x03, 0x04]) } }),
      { path: '/workspace/archive.zip' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('not a supported image or video file');
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

  it('downsamples large images and points the model to region readback', async () => {
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
    expect(systemText).toContain('region');

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

    expect(result).toEqual({
      isError: true,
      output:
        'Image is too large to send safely after compression (262168 bytes; limit 262144 bytes and 2000px on the longest edge). ' +
        'The original image was not sent to the model. Do not retry the same file unchanged. ' +
        'Use Bash or an available image-processing tool to create a smaller copy within both limits, ' +
        'then call ReadMediaFile on the smaller copy.',
    });
  });

  it('returns an actionable error when compression cannot meet the pixel budget', async () => {
    const result = await execute(
      makeTool({ '/workspace/wide.png': { data: pngBuffer(2001, 1000) } }),
      { path: '/workspace/wide.png' },
    );

    expect(result).toEqual({
      isError: true,
      output:
        'Image is too large to send safely after compression (24 bytes; limit 262144 bytes and 2000px on the longest edge). ' +
        'The original image was not sent to the model. Do not retry the same file unchanged. ' +
        'Use Bash or an available image-processing tool to create a smaller copy within both limits, ' +
        'then call ReadMediaFile on the smaller copy.',
    });
  });

  it('reads only the sniff header when the default image exceeds the safe decode allocation', async () => {
    const fs = createTestFs({
      '/workspace/huge.png': { data: pngBuffer(), size: MAX_IMAGE_DECODE_BYTES + 1 },
    });
    const tool = new ReadMediaFileTool(environmentFor(fs), WORKSPACE, testMediaStore());

    const result = await execute(tool, { path: '/workspace/huge.png' });

    expect(result).toEqual({
      isError: true,
      output:
        'Image is too large to send safely after compression (67108865 bytes; limit 262144 bytes and 2000px on the longest edge). ' +
        'The original image was not sent to the model. Do not retry the same file unchanged. ' +
        'Use Bash or an available image-processing tool to create a smaller copy within both limits, ' +
        'then call ReadMediaFile on the smaller copy.',
    });
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledOnce();
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledWith('/workspace/huge.png', 512);
  });

  it('does not treat the decode allocation cap as a hard limit when the configured delivery budget accepts the file', async () => {
    setConfiguredReadImageByteBudget(70 * 1024 * 1024);
    const fs = createTestFs({
      '/workspace/large.png': { data: pngBuffer(), size: MAX_IMAGE_DECODE_BYTES + 1 },
    });
    const tool = new ReadMediaFileTool(environmentFor(fs), WORKSPACE, testMediaStore());

    const result = await execute(tool, { path: '/workspace/large.png' });

    expect(result.isError).toBe(false);
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fs.readBytes)).toHaveBeenLastCalledWith('/workspace/large.png', undefined);
  });

  it('returns external preprocessing guidance before loading an oversized region source', async () => {
    const fs = createTestFs({
      '/workspace/huge.png': { data: pngBuffer(), size: MAX_IMAGE_DECODE_BYTES + 1 },
    });
    const tool = new ReadMediaFileTool(environmentFor(fs), WORKSPACE, testMediaStore());

    const result = await execute(tool, {
      path: '/workspace/huge.png',
      region: { x: 0, y: 0, width: 100, height: 100 },
    });

    expect(result).toEqual({
      isError: true,
      output:
        'Image is too large to process safely for region or full_resolution (67108865 bytes; safe decode limit 67108864 bytes). ' +
        'The original image was not sent to the model. Do not retry the same file unchanged. ' +
        'Use Bash or an available image-processing tool to create a smaller copy or crop the needed ' +
        'region into a separate image, then call ReadMediaFile on the resulting file.',
    });
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledOnce();
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledWith('/workspace/huge.png', 512);
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

  it('reads image regions at native resolution', async () => {
    const big = Buffer.from(
      await new Jimp({ width: 2100, height: 2100, color: 0x3366ccff }).getBuffer('image/png'),
    );
    const store = testMediaStore();
    const result = await execute(
      makeTool({ '/workspace/big.png': { data: big } }, undefined, store),
      { path: '/workspace/big.png', region: { x: 100, y: 50, width: 400, height: 300 } },
    );
    const stored = await store.get(mediaUrl(outputParts(result)[1]));
    expect(sniffImageDimensions(Buffer.from(stored!.bytes))).toEqual({
      width: 400,
      height: 300,
    });
    const systemText = noteText(result);
    expect(systemText).toContain('2100x2100');
    expect(systemText).toMatch(/region \(x=100, y=50, width=400, height=300\)/);
    expect(systemText).toMatch(/native resolution/);
    expect(systemText).toContain('offset');
  });

  it('rejects a region outside the image with the original size in the error', async () => {
    const big = Buffer.from(
      await new Jimp({ width: 2100, height: 2100, color: 0x3366ccff }).getBuffer('image/png'),
    );
    const result = await execute(makeTool({ '/workspace/big.png': { data: big } }), {
      path: '/workspace/big.png',
      region: { x: 5000, y: 0, width: 100, height: 100 },
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('2100x2100');
  });

  it('serves full_resolution when the bytes fit the per-image budget', async () => {
    const big = Buffer.from(
      await new Jimp({ width: 2100, height: 1050, color: 0x3366ccff }).getBuffer('image/png'),
    );
    const store = testMediaStore();
    const result = await execute(
      makeTool({ '/workspace/big.png': { data: big } }, undefined, store),
      { path: '/workspace/big.png', full_resolution: true },
    );

    const stored = await store.get(mediaUrl(outputParts(result)[1]));
    expect(Buffer.from(stored!.bytes)).toEqual(big);
    expect(noteText(result)).toMatch(/native resolution/);
  });

  it('returns the configured full_resolution limit error before loading an over-budget image', async () => {
    const data = Buffer.concat([pngBuffer(), Buffer.alloc(4 * 1024 * 1024, 1)]);
    const fs = createTestFs({ '/workspace/huge.png': { data } });
    const tool = new ReadMediaFileTool(environmentFor(fs), WORKSPACE, testMediaStore());

    const result = await execute(tool, {
      path: '/workspace/huge.png',
      full_resolution: true,
    });
    expect(result).toEqual({
      isError: true,
      output:
        '"/workspace/huge.png" is 4194328 bytes (4.0 MB), over the 262144-byte (256 KB) ' +
        'per-image limit, so full_resolution cannot be honored. ' +
        'Use region to view a crop at full fidelity instead.',
    });
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledOnce();
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledWith('/workspace/huge.png', 512);
  });

  it('prioritizes external preprocessing guidance for full_resolution above the decode cap', async () => {
    const fs = createTestFs({
      '/workspace/huge.png': { data: pngBuffer(), size: MAX_IMAGE_DECODE_BYTES + 1 },
    });
    const tool = new ReadMediaFileTool(environmentFor(fs), WORKSPACE, testMediaStore());

    const result = await execute(tool, {
      path: '/workspace/huge.png',
      full_resolution: true,
    });

    expect(result).toEqual({
      isError: true,
      output:
        'Image is too large to process safely for region or full_resolution (67108865 bytes; safe decode limit 67108864 bytes). ' +
        'The original image was not sent to the model. Do not retry the same file unchanged. ' +
        'Use Bash or an available image-processing tool to create a smaller copy or crop the needed ' +
        'region into a separate image, then call ReadMediaFile on the resulting file.',
    });
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledOnce();
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledWith('/workspace/huge.png', 512);
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

  it('reports the decoded size for a region read of an EXIF-rotated image', async () => {
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
      region: { x: 0, y: 0, width: 40, height: 40 },
    });

    expect(noteText(result)).toContain('Original dimensions: 80x120');
  });

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

  it('emits image_compress and image_crop telemetry tagged read_media', async () => {
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

    await execute(tool, {
      path: '/workspace/big.png',
      region: { x: 0, y: 0, width: 100, height: 100 },
    });
    expect(records).toHaveLength(2);
    expect(records[1]!.event).toBe('image_crop');
    expect(records[1]!.properties?.['source']).toBe('read_media');
    expect(records[1]!.properties?.['ok']).toBe(true);
  });

  it('puts an image without checking model capabilities during execution', async () => {
    const result = await execute(
      makeTool({ '/workspace/sample.png': { data: pngBuffer() } }),
      { path: '/workspace/sample.png' },
    );
    expect(result.isError).not.toBe(true);
    expect(mediaUrl(outputParts(result)[1])).toContain('kimi-file://');
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

  it('rejects region and full_resolution for videos', async () => {
    const tool = makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } });
    const withRegion = await execute(tool, {
      path: '/workspace/clip.mp4',
      region: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(withRegion.isError).toBe(true);
    expect(withRegion.output).toMatch(/image files/i);

    const withFullResolution = await execute(tool, {
      path: '/workspace/clip.mp4',
      full_resolution: true,
    });
    expect(withFullResolution.isError).toBe(true);
    expect(withFullResolution.output).toMatch(/image files/i);
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

  it('does not perform an auth-bearing upload during execution', async () => {
    const result = await execute(makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } }), {
      path: '/workspace/clip.mp4',
    });

    expect(result.isError).not.toBe(true);
    expect(mediaUrl(outputParts(result)[1])).toMatch(/^kimi-file:\/\//);
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
      name: 'stub',
      aliases: [],
      protocol: 'openai',
      baseUrl: 'https://example.test',
      headers: {},
      capabilities: capabilities(),
      maxContextSize: 1000,
      alwaysThinking: false,
      providerName: 'p',
      providerType: 'kimi',
    };
    const resolver = new AgentMediaResolverService(
      {} as IFileService,
      { get: async () => undefined, put: async () => {} } as unknown as IBlobStore,
      telemetry,
      new AgentStateService(),
      store,
      { dispatch: async () => {} } as unknown as IEventDispatcher,
      makeAgentScopeContext({ agentId: 'main', agentScope: '' }),
    );
    const resolved = await resolver.resolve(
      [{ role: 'user', content: outputParts(result) }],
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

  it('preserves video bytes for providers that inline on a later request', async () => {
    const store = testMediaStore();
    const result = await execute(
      makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } }, undefined, store),
      { path: '/workspace/clip.mp4' },
    );

    const stored = await store.get(mediaUrl(outputParts(result)[1]));
    expect(Buffer.from(stored!.bytes)).toEqual(mp4Buffer());
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

describe('registerMediaTools', () => {
  const fs = createTestFs({});
  const env = createTestEnv();

  it('registers ReadMediaFile by default and unregisters on dispose', () => {
    const registry = new AgentToolRegistryService();
    const disposable = registerMediaTools(registry, {
      environment: environmentFor(fs, env),
      workspace: WORKSPACE,
      attachmentStore: testMediaStore(),
    });
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);
    disposable.dispose();
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();
  });

  it('puts a video through the default-registered tool', async () => {
    const registry = new AgentToolRegistryService();
    registerMediaTools(registry, {
      environment: environmentFor(createTestFs({ '/workspace/clip.mp4': { data: mp4Buffer() } }), env),
      workspace: WORKSPACE,
      attachmentStore: testMediaStore(),
    });
    const result = await execute(registry.resolve('ReadMediaFile') as ReadMediaFileTool, { path: '/workspace/clip.mp4' });
    expect(result.isError).not.toBe(true);
    expect(mediaUrl(outputParts(result)[1])).toContain('kimi-file://');
  });

  it('registers without requiring media capability metadata', () => {
    const registry = new AgentToolRegistryService();
    const disposable = registerMediaTools(registry, {
      environment: environmentFor(fs, env),
      workspace: WORKSPACE,
      attachmentStore: testMediaStore(),
    });
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);
    expect(() => disposable.dispose()).not.toThrow();
  });

  it('keeps attachment reads available when the environment lacks filesystem availability', () => {
    const registry = new AgentToolRegistryService();
    const availableEnvironment = environmentFor(fs, env);
    registerMediaTools(registry, {
      environment: { ...availableEnvironment, isAvailable: () => false },
      workspace: WORKSPACE,
      attachmentStore: testMediaStore(),
    });
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);
  });
});

describe('AgentMediaToolsRegistrar', () => {
  interface ProfileState {
    alias: string;
    capabilities: ModelCapability;
  }

  function createRegistrarHarness(
    files: Record<string, FakeFile> = {},
    attachmentStore?: ISessionMediaStore,
  ) {
    const registry = new AgentToolRegistryService();
    const eventBus = new EventBusService();
    const onDidRestore = new OrderedHookSlot();
    const dispatcher = { hooks: { onDidRestore } } as unknown as IEventDispatcher;
    const agentContext = stubAgentContext('main', 1);
    eventBus.activateAgent(agentContext);
    const state: ProfileState = {
      alias: '',
      capabilities: capabilities({ image_in: false, video_in: false }),
    };
    const workspaceCtx = {
      workDir: '/workspace',
      additionalDirs: [],
    } as unknown as ISessionWorkspaceContext;
    const baseEnvironment = environmentFor(createTestFs(files));
    const environmentChanges = new Emitter<void>();
    let environmentAvailable = true;
    const environment: IAgentEnvironmentService = {
      _serviceBrand: undefined,
      onDidChange: environmentChanges.event,
      isAvailable: (required = []) => environmentAvailable && baseEnvironment.isAvailable(required),
      inspect: () => {
        if (!environmentAvailable) throw new Error('environment unavailable');
        return baseEnvironment.inspect();
      },
      acquire: (required = []) => baseEnvironment.acquire(required),
      acquireWhenReady: async (required = []) => baseEnvironment.acquire(required),
      workspaceRoots: () => ({ workDir: '/workspace', additionalDirs: [] }),
    };
    const registrar = new AgentMediaToolsRegistrar(
      registry,
      eventBus,
      dispatcher,
      environment,
      workspaceCtx,
      recordingTelemetry([]),
      new AgentStateService(),
      attachmentStore ?? testMediaStore(),
      undefined,
    );
    const bindModel = (alias: string, caps: ModelCapability): void => {
      state.alias = alias;
      state.capabilities = caps;
      eventBus.publish(
        new AgentStatusUpdated({
          agentId: 'main',
          model: alias,
          maxContextTokens: caps.max_context_tokens,
        }),
        agentContext,
      );
    };
    const setEnvironmentAvailable = (available: boolean): void => {
      environmentAvailable = available;
      environmentChanges.fire();
    };
    return { registry, registrar, state, onDidRestore, bindModel, setEnvironmentAvailable };
  }

  it('registers before model binding and keeps the same tool across model updates', () => {
    const { registry, bindModel } = createRegistrarHarness();
    const first = registry.resolve('ReadMediaFile');
    expect(first).toBeInstanceOf(ReadMediaFileTool);

    bindModel('vision-model', capabilities({ image_in: true, video_in: false }));
    const second = registry.resolve('ReadMediaFile');
    expect(second).toBe(first);
    expect((second as ReadMediaFileTool).description).not.toContain('current model');
  });

  it('keeps ReadMediaFile registered after a silent profile restore', async () => {
    const { registry, state, onDidRestore } = createRegistrarHarness();
    state.alias = 'vision-model';
    state.capabilities = capabilities({ image_in: true, video_in: false });
    const first = registry.resolve('ReadMediaFile');
    expect(first).toBeInstanceOf(ReadMediaFileTool);

    await onDidRestore.run({});

    expect(registry.resolve('ReadMediaFile')).toBe(first);
  });

  it('puts HEIC independently of the bound provider', async () => {
    const heic = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
      0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
    ]);
    const { registry, bindModel } = createRegistrarHarness({ '/workspace/photo.heic': { data: heic } });
    const readWith = async (alias: string) => {
      bindModel(alias, capabilities({ image_in: true, video_in: false }));
      const tool = registry.resolve('ReadMediaFile') as ReadMediaFileTool;
      return execute(tool, { path: '/workspace/photo.heic' });
    };

    expect((await readWith('kimi-vision')).isError).toBeFalsy();
    expect((await readWith('other-vision')).isError).toBeFalsy();
  });

  it('keeps the same ReadMediaFile instance when the model alias changes', () => {
    const { registry, bindModel } = createRegistrarHarness();
    bindModel('vision', capabilities({ image_in: true, video_in: false }));
    const first = registry.resolve('ReadMediaFile');

    bindModel('other-vision', capabilities({ image_in: true, video_in: false }));
    expect(registry.resolve('ReadMediaFile')).toBe(first);
  });

  it('keeps the tool registered when the model loses media input', () => {
    const { registry, bindModel } = createRegistrarHarness();
    bindModel('vision-model', capabilities({ image_in: true, video_in: true }));
    const first = registry.resolve('ReadMediaFile');
    expect(first).toBeInstanceOf(ReadMediaFileTool);

    bindModel('text-model', capabilities({ image_in: false, video_in: false }));
    expect(registry.resolve('ReadMediaFile')).toBe(first);
  });

  it('keeps attachment reads available across environment filesystem changes', () => {
    const { registry, bindModel, setEnvironmentAvailable } = createRegistrarHarness();
    bindModel('vision-model', capabilities({ image_in: true, video_in: true }));
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);

    setEnvironmentAvailable(false);
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);

    setEnvironmentAvailable(true);
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);
  });

  it.each([undefined, { x: 0, y: 0, width: 16, height: 16 }])('keeps session-image reads available while the workspace environment is unavailable (region=%j)', async (region) => {
    const storage = new InMemoryStorageService();
    const store = new SessionMediaStoreService(makeSessionContext({
      sessionId: 'session', workspaceId: 'workspace', cwd: '/workspace',
      sessionDir: '/session', sessionScope: 'session',
    }), storage, new JsonAtomicDocumentStore(storage));
    const bytes = Buffer.from(await new Jimp({ width: 32, height: 32, color: 0x3366ccff }).getBuffer('image/png'));
    await store.materialize({ fileId: 'f_picture', name: 'picture.png', mimeType: 'image/png', size: bytes.length, stream: () => Readable.from([bytes]) });
    const { registry, bindModel, setEnvironmentAvailable } = createRegistrarHarness({}, store);
    bindModel('vision-model', capabilities({ image_in: true, video_in: false }));
    setEnvironmentAvailable(false);
    const tool = registry.resolve('ReadMediaFile');
    expect(tool).toBeDefined();
    const execution = await tool!.resolveExecution({ path: 'kimi-file://f_picture', region });
    if (execution.isError === true) throw new Error('expected runnable attachment read');
    const result = await execution.execute({ turnId: 1, toolCallId: 'image', signal: new AbortController().signal });
    expect(result.isError).not.toBe(true);
    expect(outputParts(result).some((part) => part.type === 'image_url')).toBe(true);
  });

  it('keeps the same tool instance across media capability changes', () => {
    const { registry, bindModel } = createRegistrarHarness();
    bindModel('vision-a', capabilities({ image_in: true, video_in: true }));
    const first = registry.resolve('ReadMediaFile');

    bindModel('text-only', capabilities({ image_in: false, video_in: false }));
    expect(registry.resolve('ReadMediaFile')).toBe(first);
  });

  it('keeps the same instance across unrelated status updates', () => {
    const { registry, bindModel } = createRegistrarHarness();
    bindModel('vision-model', capabilities({ image_in: true, video_in: true }));
    const first = registry.resolve('ReadMediaFile');

    bindModel('vision-model', capabilities({ image_in: true, video_in: true }));
    expect(registry.resolve('ReadMediaFile')).toBe(first);
  });

  it('stays registered for unknown model capabilities', () => {
    const { registry, bindModel } = createRegistrarHarness();
    bindModel('unconfigured-model', UNKNOWN_CAPABILITY);
    const first = registry.resolve('ReadMediaFile');
    expect(first).toBeInstanceOf(ReadMediaFileTool);

    bindModel('vision-model', capabilities({ image_in: true, video_in: true }));
    expect(registry.resolve('ReadMediaFile')).toBe(first);
  });

  it('unregisters on dispose', () => {
    const { registry, registrar, bindModel } = createRegistrarHarness();
    bindModel('vision-model', capabilities({ image_in: true, video_in: true }));
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);

    registrar.dispose();
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();
    bindModel('vision-model-2', capabilities({ image_in: true, video_in: true }));
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();
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

  it('puts HEIC for format negotiation during resolution', async () => {
    const store = testMediaStore();
    const result = await execute(makeTool({ '/workspace/photo.heic': { data: heicBytes() } }, undefined, store), {
      path: '/workspace/photo.heic',
    });

    expect(result.isError).toBeFalsy();
    const stored = await store.get(mediaUrl(outputParts(result)[1]));
    expect(stored?.mimeType).toBe('image/heic');
    expect(Buffer.from(stored!.bytes)).toEqual(heicBytes());
  });

  function ftypBytes(brand: string): Buffer {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(24, 0);
    buf.write('ftyp', 4, 'latin1');
    buf.write(brand, 8, 'latin1');
    buf.write(brand, 16, 'latin1');
    return buf;
  }

  it('puts AVIF without consulting a provider-accepted set during execution', async () => {
    const store = testMediaStore();
    const result = await execute(makeTool({ '/workspace/photo.avif': { data: ftypBytes('avif') } }, undefined, store), {
      path: '/workspace/photo.avif',
    });

    expect(result.isError).toBeFalsy();
    const stored = await store.get(mediaUrl(outputParts(result)[1]));
    expect(stored?.mimeType).toBe('image/avif');
  });

  function mediaTool(
    files: Record<string, FakeFile>,
    store: ISessionMediaStore = testMediaStore(),
  ): ReadMediaFileTool {
    return makeTool(files, undefined, store);
  }

  it('stores HEIC untouched during execution', async () => {
    const store = testMediaStore();
    const result = await execute(mediaTool({ '/workspace/photo.heic': { data: heicBytes() } }, store), {
      path: '/workspace/photo.heic',
    });

    expect(result.isError).toBeFalsy();
    const stored = await store.get(mediaUrl(outputParts(result)[1]));
    expect(stored?.mimeType).toBe('image/heic');
    expect(Buffer.from(stored!.bytes)).toEqual(heicBytes());
    expect(noteText(result)).toContain('Mime type: image/heic.');
  });

  it('preserves a HEIC above the read budget for deferred inline resolution', async () => {
    const heic = Buffer.concat([heicBytes(), Buffer.alloc(4 * 1024 * 1024, 1)]);
    const store = testMediaStore();
    const result = await execute(mediaTool({ '/workspace/photo.heic': { data: heic } }, store), {
      path: '/workspace/photo.heic',
    });

    expect(result.isError).toBeFalsy();
    const stored = await store.get(mediaUrl(outputParts(result)[1]));
    expect(Buffer.from(stored!.bytes)).toEqual(heic);
  });

  it('preserves a HEIC above the former provider inline budget', async () => {
    const heic = Buffer.concat([heicBytes(), Buffer.alloc(5 * 1024 * 1024, 1)]);
    const store = testMediaStore();
    const result = await execute(mediaTool({ '/workspace/photo.heic': { data: heic } }, store), {
      path: '/workspace/photo.heic',
    });

    expect(result.isError).toBeFalsy();
    const stored = await store.get(mediaUrl(outputParts(result)[1]));
    expect(Buffer.from(stored!.bytes)).toEqual(heic);
  });

  it('puts AVIF for capability and format handling during resolution', async () => {
    const result = await execute(mediaTool({ '/workspace/photo.avif': { data: ftypBytes('avif') } }), {
      path: '/workspace/photo.avif',
    });

    expect(result.isError).toBeFalsy();
    expect(mediaUrl(outputParts(result)[1])).toContain('kimi-file://');
  });
});
