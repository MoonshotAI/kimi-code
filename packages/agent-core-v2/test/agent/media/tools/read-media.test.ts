/**
 * Scenario: ReadMediaFile exposes safe, capability-aware model media reads.
 *
 * Responsibilities: validates access resolution, media delivery, compression
 * budget refusal, capability gates, and registration. Wiring: real
 * ReadMediaFileTool with an in-memory host-filesystem boundary and real image
 * compression. Run: pnpm test -- test/agent/media/tools/read-media.test.ts
 */

import type { ModelCapability } from '#/kosong/contract/capability';
import type { ContentPart } from '#/kosong/contract/message';
import { Jimp } from 'jimp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { ITelemetryService, TelemetryProperties } from '#/app/telemetry/telemetry';
import {
  ReadMediaFileInputSchema,
  ReadMediaFileTool,
  type ReadMediaFileInput,
  type VideoUploader,
} from '#/agent/media/tools/read-media';
import {
  MAX_IMAGE_DECODE_BYTES,
  setConfiguredReadImageByteBudget,
} from '#/agent/media/image-compress';
import { createVideoUploader, registerMediaTools } from '#/agent/media/registerMediaTools';
import { AgentMediaToolsRegistrar } from '#/agent/media/mediaToolsRegistrar';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { EventBusService } from '#/app/event/eventBusService';
import type { IAgentProfileService } from '#/agent/profile/profile';
import type { IModelCatalog } from '#/kosong/model/catalog';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { WorkspaceConfig } from '#/tool/path-access';
import { sniffImageDimensions } from '#/agent/media/file-type';

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
    track2: (event, properties) => telemetry.track(event, properties as TelemetryProperties),
    withContext: () => telemetry,
    setContext: () => {},
    addAppender: () => ({ dispose: () => {} }),
    removeAppender: () => {},
    setAppender: () => {},
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

function makeTool(
  files: Record<string, FakeFile>,
  caps: ModelCapability = capabilities(),
  videoUploader?: VideoUploader,
  telemetry?: ITelemetryService,
): ReadMediaFileTool {
  return new ReadMediaFileTool(
    createTestFs(files),
    createTestEnv(),
    WORKSPACE,
    caps,
    videoUploader,
    telemetry,
  );
}

async function execute(
  tool: ReadMediaFileTool,
  args: ReadMediaFileInput,
): Promise<ExecutableToolResult> {
  const execution = tool.resolveExecution(args);
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

function noteText(result: ExecutableToolResult): string {
  expect(typeof result.note).toBe('string');
  return result.note as string;
}

describe('ReadMediaFileTool', () => {
  it('has name, parameters, and a path-scoped read access', () => {
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

    const execution = tool.resolveExecution({ path: '/workspace/sample.png' }) as Extract<
      ToolExecution,
      { execute: unknown }
    >;
    expect(execution.accesses).toEqual(ToolAccesses.readFile('/workspace/sample.png'));
    expect(execution.approvalRule).toBe('ReadMediaFile(/workspace/sample.png)');
  });

  it('reflects model capabilities in its description', () => {
    expect(makeTool({}, capabilities({ image_in: true, video_in: true })).description).toContain(
      'image and video files',
    );
    expect(makeTool({}, capabilities({ image_in: true, video_in: false })).description).toContain(
      'Video files are not supported',
    );
    expect(makeTool({}, capabilities({ image_in: false, video_in: true })).description).toContain(
      'Image files are not supported',
    );
    expect(makeTool({}, capabilities({ image_in: false, video_in: false })).description).toContain(
      'does not support image or video input',
    );
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
    expect(parts[1]).toMatchObject({
      type: 'image_url',
      imageUrl: { url: expect.stringContaining('data:image/png;base64,') },
    });
    expect(parts[2]).toEqual({ type: 'text', text: '</image>' });
  });

  it('downsamples large images and points the model to region readback', async () => {
    const big = Buffer.from(
      await new Jimp({ width: 2200, height: 2200, color: 0x3366ccff }).getBuffer('image/png'),
    );
    expect(sniffImageDimensions(big)).toEqual({ width: 2200, height: 2200 });

    const result = await execute(makeTool({ '/workspace/big.png': { data: big } }), {
      path: '/workspace/big.png',
    });

    const systemText = noteText(result);
    expect(systemText).toContain('2200x2200');
    expect(systemText).toContain(`${String(big.length)} bytes`);
    expect(systemText).toMatch(/The attached image was downsampled to 2000x2000/);
    expect(systemText).toMatch(/fine detail/i);
    expect(systemText).toContain('region');

    const parts = outputParts(result);
    const url = (parts[1] as { imageUrl: { url: string } }).imageUrl.url;
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(url);
    expect(match).not.toBeNull();
    const dims = sniffImageDimensions(Buffer.from(match![2]!, 'base64'));
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
    const tool = new ReadMediaFileTool(fs, createTestEnv(), WORKSPACE, capabilities());

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
    const tool = new ReadMediaFileTool(fs, createTestEnv(), WORKSPACE, capabilities());

    const result = await execute(tool, { path: '/workspace/large.png' });

    expect(result.isError).toBe(false);
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fs.readBytes)).toHaveBeenLastCalledWith('/workspace/large.png');
  });

  it('returns external preprocessing guidance before loading an oversized region source', async () => {
    const fs = createTestFs({
      '/workspace/huge.png': { data: pngBuffer(), size: MAX_IMAGE_DECODE_BYTES + 1 },
    });
    const tool = new ReadMediaFileTool(fs, createTestEnv(), WORKSPACE, capabilities());

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
    const result = await execute(makeTool({ '/workspace/big.png': { data: big } }), {
      path: '/workspace/big.png',
      region: { x: 100, y: 50, width: 400, height: 300 },
    });
    const parts = outputParts(result);
    const url = (parts[1] as { imageUrl: { url: string } }).imageUrl.url;
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(url);
    expect(match).not.toBeNull();
    expect(sniffImageDimensions(Buffer.from(match![2]!, 'base64'))).toEqual({
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
    const result = await execute(makeTool({ '/workspace/big.png': { data: big } }), {
      path: '/workspace/big.png',
      full_resolution: true,
    });

    const parts = outputParts(result);
    expect((parts[1] as { imageUrl: { url: string } }).imageUrl.url).toBe(
      `data:image/png;base64,${big.toString('base64')}`,
    );
    expect(noteText(result)).toMatch(/native resolution/);
  });

  it('returns the existing full_resolution limit error before loading an over-budget image', async () => {
    const data = Buffer.concat([pngBuffer(), Buffer.alloc(4 * 1024 * 1024, 1)]);
    const fs = createTestFs({ '/workspace/huge.png': { data } });
    const tool = new ReadMediaFileTool(fs, createTestEnv(), WORKSPACE, capabilities());

    const result = await execute(tool, {
      path: '/workspace/huge.png',
      full_resolution: true,
    });
    expect(result).toEqual({
      isError: true,
      output:
        '"/workspace/huge.png" is 4194328 bytes (4.0 MB), over the 3932160-byte (3.8 MB) ' +
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
    const tool = new ReadMediaFileTool(fs, createTestEnv(), WORKSPACE, capabilities());

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
      capabilities(),
      undefined,
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

  it('errors when reading an image without image input capability', async () => {
    const result = await execute(
      makeTool(
        { '/workspace/sample.png': { data: pngBuffer() } },
        capabilities({ image_in: false, video_in: true }),
      ),
      { path: '/workspace/sample.png' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not support image input');
  });

  it('wraps a video as a data URL when no uploader is provided', async () => {
    const result = await execute(makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } }), {
      path: '/workspace/clip.mp4',
    });

    const systemText = noteText(result);
    expect(systemText).toMatch(/^<system>.*<\/system>$/s);
    expect(systemText).toContain('video/mp4');

    const parts = outputParts(result);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: '<video path="/workspace/clip.mp4">' });
    expect(parts[1]).toMatchObject({
      type: 'video_url',
      videoUrl: { url: expect.stringContaining('data:video/mp4;base64,') },
    });
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

  it('uses the video uploader when provided', async () => {
    const uploadResult = {
      type: 'video_url' as const,
      videoUrl: { url: 'https://example.com/uploaded.mp4' },
    };
    const videoUploader = vi.fn<VideoUploader>().mockResolvedValue(uploadResult);
    const result = await execute(
      makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } }, capabilities(), videoUploader),
      { path: '/workspace/clip.mp4' },
    );
    const parts = outputParts(result);
    expect(videoUploader).toHaveBeenCalledOnce();
    expect(videoUploader).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'video/mp4', filename: 'clip.mp4' }),
    );
    expect(parts[1]).toEqual(uploadResult);
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

  it('registers ReadMediaFile when the model supports image input', () => {
    const registry = new AgentToolRegistryService();
    const disposable = registerMediaTools(registry, {
      fs,
      env,
      workspace: WORKSPACE,
      capabilities: capabilities({ image_in: true, video_in: false }),
    });
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);
    disposable.dispose();
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();
  });

  it('registers ReadMediaFile when the model supports video input', () => {
    const registry = new AgentToolRegistryService();
    registerMediaTools(registry, {
      fs,
      env,
      workspace: WORKSPACE,
      capabilities: capabilities({ image_in: false, video_in: true }),
    });
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);
  });

  it('does not register anything when the model lacks media capability', () => {
    const registry = new AgentToolRegistryService();
    const disposable = registerMediaTools(registry, {
      fs,
      env,
      workspace: WORKSPACE,
      capabilities: capabilities({ image_in: false, video_in: false }),
    });
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();
    expect(() => disposable.dispose()).not.toThrow();
  });
});

describe('AgentMediaToolsRegistrar', () => {
  interface ProfileState {
    alias: string;
    capabilities: ModelCapability;
  }

  function createRegistrarHarness() {
    const registry = new AgentToolRegistryService();
    const eventBus = new EventBusService();
    const state: ProfileState = {
      alias: '',
      capabilities: capabilities({ image_in: false, video_in: false }),
    };
    const profile = {
      getModelCapabilities: () => state.capabilities,
      getModel: () => state.alias,
    } as unknown as IAgentProfileService;
    const modelCatalog = {
      getRequester: (id: string) => ({
        model: { id, name: id, providerName: 'test', protocol: 'openai' },
      }),
    } as unknown as IModelCatalog;
    const workspaceCtx = {
      workDir: '/workspace',
      additionalDirs: [],
    } as unknown as ISessionWorkspaceContext;
    const registrar = new AgentMediaToolsRegistrar(
      registry,
      profile,
      modelCatalog,
      eventBus,
      createTestFs({}),
      createTestEnv(),
      workspaceCtx,
      recordingTelemetry([]),
    );
    const bindModel = (alias: string, caps: ModelCapability): void => {
      state.alias = alias;
      state.capabilities = caps;
      eventBus.publish({
        type: 'agent.status.updated',
        model: alias,
        maxContextTokens: caps.max_context_tokens,
      });
    };
    return { registry, registrar, bindModel };
  }

  it('registers nothing until a media-capable model binds, then registers ReadMediaFile', () => {
    const { registry, bindModel } = createRegistrarHarness();
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();

    bindModel('vision-model', capabilities({ image_in: true, video_in: false }));
    const tool = registry.resolve('ReadMediaFile');
    expect(tool).toBeInstanceOf(ReadMediaFileTool);
    expect((tool as ReadMediaFileTool).description).toContain('Video files are not supported');
  });

  it('drops the tool when the model loses media input', () => {
    const { registry, bindModel } = createRegistrarHarness();
    bindModel('vision-model', capabilities({ image_in: true, video_in: true }));
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);

    bindModel('text-model', capabilities({ image_in: false, video_in: false }));
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();
  });

  it('swaps the tool instance when the model alias changes', () => {
    const { registry, bindModel } = createRegistrarHarness();
    bindModel('vision-a', capabilities({ image_in: true, video_in: true }));
    const first = registry.resolve('ReadMediaFile');

    bindModel('vision-b', capabilities({ image_in: true, video_in: true }));
    const second = registry.resolve('ReadMediaFile');
    expect(second).toBeInstanceOf(ReadMediaFileTool);
    expect(second).not.toBe(first);
  });

  it('keeps the same instance across unrelated status updates', () => {
    const { registry, bindModel } = createRegistrarHarness();
    bindModel('vision-model', capabilities({ image_in: true, video_in: true }));
    const first = registry.resolve('ReadMediaFile');

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

  function modelWith(uploadVideo: ModelRequester['uploadVideo']): Pick<ModelRequester, 'uploadVideo'> {
    return { uploadVideo } as Pick<ModelRequester, 'uploadVideo'>;
  }

  it('returns undefined when the model does not support video upload', () => {
    expect(createVideoUploader(undefined)).toBeUndefined();
    expect(createVideoUploader({} as Pick<ModelRequester, 'uploadVideo'>)).toBeUndefined();
  });

  it('binds uploadVideo without telemetry', async () => {
    const uploadVideo = vi.fn().mockResolvedValue(uploadResult);
    const uploader = createVideoUploader(modelWith(uploadVideo));
    await expect(uploader!(input)).resolves.toEqual(uploadResult);
    expect(uploadVideo).toHaveBeenCalledWith(input);
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

  it('refuses HEIC with a conversion command for the execution environment', async () => {
    const result = await execute(makeTool({ '/workspace/photo.heic': { data: heicBytes() } }), {
      path: '/workspace/photo.heic',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('image/heic');
    expect(result.output).toContain('Convert it to JPEG first');
    expect(result.output).toContain('/workspace/photo.jpg');
    expect(result.output).toMatch(/sips -s format jpeg|heif-convert|magick/);
  });

  function ftypBytes(brand: string): Buffer {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(24, 0);
    buf.write('ftyp', 4, 'latin1');
    buf.write(brand, 8, 'latin1');
    buf.write(brand, 16, 'latin1');
    return buf;
  }

  it('refuses every format outside the provider-accepted set, not just HEIC', async () => {
    const result = await execute(makeTool({ '/workspace/photo.avif': { data: ftypBytes('avif') } }), {
      path: '/workspace/photo.avif',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('image/avif');
    expect(result.output).toContain('Convert it to JPEG first');
    expect(result.output).toContain('/workspace/photo.jpg');
    expect(result.output).toMatch(/sips -s format jpeg|magick/);
    expect(result.output).not.toContain('heif-convert');
  });
});
