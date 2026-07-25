/**
 * ReadMediaFileTool public execution contract: capability and path gating,
 * model-safe media delivery, compression/crop behavior, and actionable
 * failures. Real codecs are used; Kaos is the only stubbed I/O boundary.
 * Run with: pnpm --filter @moonshot-ai/agent-core test -- read-media.test.ts
 */

import type { Kaos } from '@moonshot-ai/kaos';
import type { ContentPart, ModelCapability } from '@moonshot-ai/kosong';
import { Jimp } from 'jimp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolAccesses } from '../../src/loop';
import type { ExecutableToolResult } from '../../src/loop';
import {
  ReadMediaFileInputSchema,
  ReadMediaFileTool,
} from '../../src/tools/builtin/file/read-media';
import { MAX_IMAGE_DECODE_BYTES } from '../../src/tools/support/image-compress';
import { ImageLimits } from '../../src/tools/support/image-limits';
import { MEDIA_SNIFF_BYTES, sniffImageDimensions } from '../../src/tools/support/file-type';
import type { TelemetryClient } from '../../src/telemetry';
import { createFakeKaos, FAKE_OS_ENV, PERMISSIVE_WORKSPACE } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

const DEFAULT_STAT = {
  stMode: 0o100644,
  stIno: 0,
  stDev: 0,
  stNlink: 1,
  stUid: 0,
  stGid: 0,
  stSize: 1024,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
};

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4_HEADER = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftyp'),
  Buffer.from('mp42'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom'),
]);

/**
 * Insert a minimal EXIF APP1 segment carrying only an Orientation tag right
 * after the JPEG SOI marker (jimp itself never writes EXIF). Mirrors the
 * fixture in image-compress.test.ts.
 */
function withExifOrientation(jpeg: Uint8Array, orientation: number): Buffer {
  // TIFF body, little-endian: 8-byte header + IFD0 with a single entry.
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // offset of IFD0
  tiff.writeUInt16LE(1, 8); // one directory entry
  tiff.writeUInt16LE(0x0112, 10); // tag: Orientation
  tiff.writeUInt16LE(3, 12); // type: SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(orientation, 18); // value, left-aligned in the 4-byte field
  tiff.writeUInt32LE(0, 22); // no next IFD
  const exifBody = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1Header = Buffer.alloc(4);
  app1Header.writeUInt16BE(0xff_e1, 0);
  app1Header.writeUInt16BE(exifBody.length + 2, 2);
  return Buffer.concat([
    Buffer.from(jpeg.subarray(0, 2)), // SOI
    app1Header,
    exifBody,
    Buffer.from(jpeg.subarray(2)),
  ]);
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

function makeReadMediaTool(
  input: {
    readonly stat?: Kaos['stat'] | undefined;
    readonly readBytes?: Kaos['readBytes'] | undefined;
    readonly modelCapabilities?: ModelCapability | undefined;
    readonly telemetry?: TelemetryClient | undefined;
    readonly imageLimits?: ImageLimits | undefined;
  } = {},
): ReadMediaFileTool {
  const kaos = createFakeKaos({
    stat: input.stat ?? vi.fn<Kaos['stat']>().mockResolvedValue(DEFAULT_STAT),
    readBytes: input.readBytes ?? vi.fn<Kaos['readBytes']>().mockResolvedValue(PNG_HEADER),
  });
  return new ReadMediaFileTool(
    kaos,
    PERMISSIVE_WORKSPACE,
    input.modelCapabilities ?? capabilities(),
    undefined,
    input.telemetry,
    input.imageLimits,
  );
}

function outputParts(result: ExecutableToolResult): ContentPart[] {
  expect(result.isError).toBeFalsy();
  expect(Array.isArray(result.output)).toBe(true);
  return result.output as ContentPart[];
}

// The media summary rides the result's `note` side channel (rendered to the
// model at projection time, never to UIs); the tool keeps its own `<system>`
// wrapping as a wording choice.
function noteText(result: ExecutableToolResult): string {
  expect(typeof result.note).toBe('string');
  return result.note as string;
}

describe('ReadMediaFileTool', () => {
  it('has name, parameters, and path-scoped resource accesses', () => {
    const tool = makeReadMediaTool();

    expect(tool.name).toBe('ReadMediaFile');
    expect(ReadMediaFileInputSchema.safeParse({ path: '/workspace/sample.png' }).success).toBe(
      true,
    );
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
    });
    const execution = tool.resolveExecution({ path: '/workspace/sample.png' });
    expect(execution.isError).toBeFalsy();
    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.accesses).toEqual(ToolAccesses.readFile('/workspace/sample.png'));
  });

  it('describes the path parameter with accurate working-directory semantics', () => {
    const tool = makeReadMediaTool();
    const pathSchema = (tool.parameters as { properties: { path: { description?: string } } })
      .properties.path;

    expect(pathSchema.description).toBeDefined();
    const description = pathSchema.description ?? '';
    // The description must explain that relative paths resolve against the
    // working directory — not the misleading "Absolute path" wording.
    expect(description).toMatch(/working directory/i);
    expect(description).not.toMatch(/^Absolute path/);
    // The useful "directories and text files are not supported" note stays.
    expect(description).toMatch(/text file/i);
  });

  it('throws when constructed without image or video capability', () => {
    expect(
      () =>
        new ReadMediaFileTool(
          createFakeKaos(),
          PERMISSIVE_WORKSPACE,
          capabilities({ image_in: false, video_in: false }),
        ),
    ).toThrow(/image_in or video_in/);
  });

  it('returns a text/image/text wrap plus a <system> note for PNG files', async () => {
    const data = Buffer.concat([PNG_HEADER, Buffer.from('pngdata')]);
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c1',
      args: { path: '/workspace/sample.png' },
      signal,
    });

    expect(noteText(result)).toMatch(/^<system>.*<\/system>$/s);
    const parts = outputParts(result);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: '<image path="/workspace/sample.png">' });
    expect(parts[1]).toMatchObject({ type: 'image_url' });
    expect((parts[1] as { imageUrl: { url: string } }).imageUrl.url).toBe(
      `data:image/png;base64,${data.toString('base64')}`,
    );
    expect(parts[2]).toEqual({ type: 'text', text: '</image>' });
  });

  it('emits a <system> summary with mime type and byte size for images', async () => {
    const data = Buffer.concat([PNG_HEADER, Buffer.from('pngdata')]);
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_sys',
      args: { path: '/workspace/sample.png' },
      signal,
    });

    const systemText = noteText(result);
    expect(systemText).toContain('image/png');
    expect(systemText).toContain(`${String(data.length)} bytes`);
    // The re-read reminder is included regardless of dimensions.
    expect(systemText).toMatch(/read the result back/i);
  });

  it('includes original pixel dimensions in the <system> summary for images', async () => {
    // 4x2 PNG: IHDR width=4, height=2.
    const ihdr = Buffer.alloc(25);
    Buffer.from('IHDR').copy(ihdr, 4);
    ihdr.writeUInt32BE(4, 8);
    ihdr.writeUInt32BE(2, 12);
    const data = Buffer.concat([PNG_HEADER, ihdr]);
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_dim',
      args: { path: '/workspace/sized.png' },
      signal,
    });

    const systemText = noteText(result);
    expect(systemText).toContain('4x2');
    // With the original size known, the coordinate guidance is included.
    expect(systemText).toMatch(/relative coordinates first/i);
    expect(systemText).toContain('original image size');
  });

  it('omits the dimensions line when the header is too short to size the image', async () => {
    // An 8-byte PNG: enough magic bytes to be recognised as an image,
    // but too short for the IHDR chunk, so sniffImageDimensions returns
    // null and the <system> block must drop the "Original dimensions" line.
    const data = Buffer.from(PNG_HEADER);
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_nodim',
      args: { path: '/workspace/tiny.png' },
      signal,
    });

    const systemText = noteText(result);
    // mime type and byte size are still reported …
    expect(systemText).toContain('image/png');
    expect(systemText).toContain(`${String(data.length)} bytes`);
    // … but the dimensions line is absent …
    expect(systemText).not.toContain('Original dimensions');
    // … and so is the coordinate guidance, which would otherwise dangle by
    // referencing an original size that is not present in the block.
    expect(systemText).not.toMatch(/coordinates/i);
  });

  it('emits a <system> summary for videos without pixel dimensions', async () => {
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({
        ...DEFAULT_STAT,
        stSize: MP4_HEADER.length,
      }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(MP4_HEADER),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_vsys',
      args: { path: '/workspace/clip.mp4' },
      signal,
    });

    const systemText = noteText(result);
    expect(systemText).toContain('video/mp4');
    expect(systemText).toContain(`${String(MP4_HEADER.length)} bytes`);
    // The re-read reminder is included for videos too.
    expect(systemText).toMatch(/read the result back/i);
  });

  it('detects an extensionless PNG via magic-byte sniffing', async () => {
    const data = Buffer.concat([PNG_HEADER, Buffer.from('pngdata')]);
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c2',
      args: { path: '/workspace/sample' },
      signal,
    });

    const parts = outputParts(result);
    expect(parts[0]).toEqual({ type: 'text', text: '<image path="/workspace/sample">' });
    expect((parts[1] as { imageUrl: { url: string } }).imageUrl.url).toContain('image/png');
  });

  it('expands leading tilde paths using the kaos home directory', async () => {
    const data = Buffer.concat([PNG_HEADER, Buffer.from('pngdata')]);
    const readBytes = vi.fn<Kaos['readBytes']>().mockResolvedValue(data);
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
      readBytes,
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_home',
      args: { path: '~/images/sample.png' },
      signal,
    });

    const parts = outputParts(result);
    expect(readBytes).toHaveBeenCalledWith('/home/test/images/sample.png', MEDIA_SNIFF_BYTES);
    expect(readBytes).toHaveBeenCalledWith('/home/test/images/sample.png');
    expect(parts[0]).toEqual({ type: 'text', text: '<image path="/home/test/images/sample.png">' });
  });

  it('returns a text/video/text wrap for MP4 files', async () => {
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({
        ...DEFAULT_STAT,
        stSize: MP4_HEADER.length,
      }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(MP4_HEADER),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c3',
      args: { path: '/workspace/sample.mp4' },
      signal,
    });

    expect(noteText(result)).toMatch(/^<system>.*<\/system>$/s);
    const parts = outputParts(result);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: '<video path="/workspace/sample.mp4">' });
    expect(parts[1]).toMatchObject({ type: 'video_url' });
    expect((parts[1] as { videoUrl: { url: string } }).videoUrl.url).toBe(
      `data:video/mp4;base64,${MP4_HEADER.toString('base64')}`,
    );
    expect(parts[2]).toEqual({ type: 'text', text: '</video>' });
  });

  it('falls back to a media extension when the header cannot be sniffed', async () => {
    const data = Buffer.from([0x00, 0x00, 0x01, 0xba, 0x21, 0x00, 0x01, 0x00]);
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_mpg',
      args: { path: '/workspace/sample.mpg' },
      signal,
    });

    const parts = outputParts(result);
    expect(parts[0]).toEqual({ type: 'text', text: '<video path="/workspace/sample.mpg">' });
    expect((parts[1] as { videoUrl: { url: string } }).videoUrl.url).toBe(
      `data:video/mpeg;base64,${data.toString('base64')}`,
    );
  });

  it('uses injected videoUploader for video files when available', async () => {
    const videoUploader = vi.fn().mockResolvedValue({
      type: 'video_url',
      videoUrl: { url: 'ms://file-123', id: 'file-123' },
    });
    const tool = new ReadMediaFileTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({
          ...DEFAULT_STAT,
          stSize: MP4_HEADER.length,
        }),
        readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(MP4_HEADER),
      }),
      PERMISSIVE_WORKSPACE,
      capabilities(),
      videoUploader,
    );

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c4',
      args: { path: '/workspace/sample.mp4' },
      signal,
    });

    expect(videoUploader).toHaveBeenCalledWith({
      data: MP4_HEADER,
      mimeType: 'video/mp4',
      filename: 'sample.mp4',
    });
    const parts = outputParts(result);
    expect(parts[1]).toEqual({
      type: 'video_url',
      videoUrl: { url: 'ms://file-123', id: 'file-123' },
    });
  });

  it('falls back to an inline base64 video part when the upload fails', async () => {
    const videoUploader = vi.fn().mockRejectedValue(new Error('404 route not found'));
    const tool = new ReadMediaFileTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({
          ...DEFAULT_STAT,
          stSize: MP4_HEADER.length,
        }),
        readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(MP4_HEADER),
      }),
      PERMISSIVE_WORKSPACE,
      capabilities(),
      videoUploader,
    );

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c4b',
      args: { path: '/workspace/sample.mp4' },
      signal,
    });

    expect(result.isError).not.toBe(true);
    const parts = outputParts(result);
    expect(parts[1]).toEqual({
      type: 'video_url',
      videoUrl: { url: `data:video/mp4;base64,${MP4_HEADER.toString('base64')}` },
    });
  });

  it('surfaces auth rejections from the upload channel instead of falling back', async () => {
    const videoUploader = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('401 Unauthorized'), { statusCode: 401 }));
    const tool = new ReadMediaFileTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({
          ...DEFAULT_STAT,
          stSize: MP4_HEADER.length,
        }),
        readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(MP4_HEADER),
      }),
      PERMISSIVE_WORKSPACE,
      capabilities(),
      videoUploader,
    );

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c4c',
      args: { path: '/workspace/sample.mp4' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('401 Unauthorized');
    expect(result.output).not.toContain('base64');
  });

  it('rejects text files with a Read hint', async () => {
    const text = Buffer.from('hello');
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: text.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(text),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c5',
      args: { path: '/workspace/sample.txt' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      '"/workspace/sample.txt" is a text file. Use Read to read text files.',
    );
    expect(result.output).not.toContain('ReadFile');
  });

  it('rejects unknown binary files without legacy Python-tool wording', async () => {
    const blob = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: blob.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(blob),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_unknown',
      args: { path: '/workspace/blob.bin' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      '"/workspace/blob.bin" is not a supported image or video file. Use Read for text files, or Bash or an MCP tool for other binary formats.',
    );
    expect(result.output).not.toContain('Python tools');
  });

  it('errors when the current model lacks video input capability', async () => {
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({
        ...DEFAULT_STAT,
        stSize: MP4_HEADER.length,
      }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(MP4_HEADER),
      modelCapabilities: capabilities({ image_in: true, video_in: false }),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c6',
      args: { path: '/workspace/sample.mp4' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/video input/i);
  });

  it('rejects empty files and files exceeding the media size limit', async () => {
    const empty = await executeTool(makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: 0 }),
    }), {
      turnId: 't1',
      toolCallId: 'c_empty',
      args: { path: '/workspace/empty.png' },
      signal,
    });
    expect(empty).toMatchObject({ isError: true });
    expect(empty.output).toMatch(/empty/i);

    const huge = await executeTool(makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({
        ...DEFAULT_STAT,
        stSize: 200 * 1024 * 1024,
      }),
    }), {
      turnId: 't1',
      toolCallId: 'c_huge',
      args: { path: '/workspace/huge.png' },
      signal,
    });
    expect(huge).toMatchObject({ isError: true });
    expect(huge.output).toMatch(/exceeds|100/i);
  });

  it('exposes a <system> summary with the original pixel size for sized images', async () => {
    // A real 3x4 RGB PNG (validated by sharp/pillow). Reading should surface
    // the original dimensions in the <system> summary so the model can map
    // coordinates. The bytes below are a hand-built minimum-valid 3x4 PNG.
    // py contract asked for a `message` sidecar with "Loaded image file ...
    // original size 3x4px"; TS settled on a leading <system> ContentPart with
    // `Read image file. ... Original dimensions: 3x4 pixels.` — same intent,
    // different wording and channel.
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000030000000408020000003a' +
        '63dc1c0000001949444154789c63606060f8cf80019aa0a8a020' +
        '00000000ffff03000c1d03014b0000000049454e44ae426082',
      'hex',
    );
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: png.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(png),
    });

    const result = await executeTool(tool,{
      turnId: 't1',
      toolCallId: 'c_size',
      args: { path: '/workspace/valid.png' },
      signal,
    });

    const systemText = noteText(result);
    expect(systemText).toContain('Read image file');
    expect(systemText).toContain('image/png');
    expect(systemText).toContain('3x4 pixels');
  });

  it('reports a <system> summary for extensionless image files', async () => {
    // Extensionless path → magic-byte sniff identifies PNG. <system> summary
    // still announces the kind, mime type, and byte size; dimensions are
    // omitted because the header is too short to read IHDR.
    const data = Buffer.concat([PNG_HEADER, Buffer.from('pngdata')]);
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
    });

    const result = await executeTool(tool,{
      turnId: 't1',
      toolCallId: 'c_extless_msg',
      args: { path: '/workspace/sample' },
      signal,
    });

    const systemText = noteText(result);
    expect(systemText).toContain('Read image file');
    expect(systemText).toContain('image/png');
    expect(systemText).toContain(`${String(data.length)} bytes`);
  });

  it('description by capabilities lockdown — image + video points at Read for text fallback', () => {
    const tool = new ReadMediaFileTool(createFakeKaos(), PERMISSIVE_WORKSPACE, capabilities());
    // Long-form description contract from sibling docs: 100MB ceiling and
    // pointer to the text-file tool for non-media content. TS renames the
    // sibling tool to `Read` (py was `ReadFile`).
    expect(tool.description).toContain('100MB');
    expect(tool.description).toContain('Read tool');
    expect(tool.description).toContain('supports image and video files for the current model');
  });

  it('omits the tool from the toolset when the model has neither image_in nor video_in', () => {
    // Strict skip semantics: construction returns a sentinel the loader can
    // use to drop the tool entirely, instead of registering a tool that
    // always errors. Currently TS throws a regular Error — fail-unimplemented
    // surfaces the gap.
    let caught: unknown = null;
    const construct = (): ReadMediaFileTool =>
      new ReadMediaFileTool(
        createFakeKaos(),
        PERMISSIVE_WORKSPACE,
        capabilities({ image_in: false, video_in: false }),
      );
    try {
      construct();
    } catch (error) {
      caught = error;
    }
    expect((caught as { name?: string } | null)?.name).toBe('SkipThisTool');
  });

  it('allows absolute media paths outside workspace but rejects relative escapes', async () => {
    const readBytes = vi.fn<Kaos['readBytes']>().mockResolvedValue(PNG_HEADER);
    const tool = new ReadMediaFileTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue(DEFAULT_STAT),
        readBytes,
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
      capabilities(),
    );

    const absolute = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_abs',
      args: { path: '/tmp/outside.png' },
      signal,
    });
    expect(absolute.isError).toBeFalsy();

    readBytes.mockClear();
    const relative = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_rel',
      args: { path: '../secret.png' },
      signal,
    });
    expect(relative.isError).toBe(true);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('uses the sniffed MIME over a mismatched image extension', async () => {
    // `.png` path but JPEG bytes — the data URL must advertise `image/jpeg`
    // (the real bytes), not `image/png` (the extension), otherwise the model
    // API rejects it as `application/octet-stream`.
    const data = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpegdata')]);
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_mismatch',
      args: { path: '/workspace/actually-jpeg.png' },
      signal,
    });

    const parts = outputParts(result);
    expect((parts[1] as { imageUrl: { url: string } }).imageUrl.url).toBe(
      `data:image/jpeg;base64,${data.toString('base64')}`,
    );
  });

  it('refuses a sniffed-but-unsupported image format instead of shipping it to the provider', async () => {
    // A `.png` file that is actually a BMP is sniffed as `image/bmp`. The tool
    // must not ship the bytes: the provider rejects BMP, and once the
    // image_url lands in the history every later request in the session fails.
    // It refuses with conversion guidance instead.
    const data = Buffer.concat([Buffer.from('BM'), Buffer.from('bmpdata')]);
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_bmp',
      args: { path: '/workspace/photo.png' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('image/bmp');
    expect(result.output).toContain('Convert it to JPEG');
    expect(result.output).toContain('/workspace/photo.jpg');
  });

  it('rejects a media-extension file whose bytes are not a supported image', async () => {
    // `.png` path with garbage bytes (no NUL) fails to sniff; the tool must
    // report "not a supported image or video file" instead of building a
    // mismatched data URL.
    const data = Buffer.from('this is not an image, just plain ascii text');
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_garbage',
      args: { path: '/workspace/fake.png' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      '"/workspace/fake.png" is not a supported image or video file. Use Read for text files, or Bash or an MCP tool for other binary formats.',
    );
  });

  it('downsamples an oversized image but reports original dimensions', async () => {
    const big = Buffer.from(
      await new Jimp({ width: 2200, height: 2200, color: 0x3366ccff }).getBuffer('image/png'),
    );
    expect(sniffImageDimensions(big)).toEqual({ width: 2200, height: 2200 });

    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: big.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(big),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_big',
      args: { path: '/workspace/big.png' },
      signal,
    });

    const parts = outputParts(result);
    const url = (parts[1] as { imageUrl: { url: string } }).imageUrl.url;
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(url);
    expect(match).not.toBeNull();
    // The image actually sent to the model is downsampled to the edge cap.
    const sentBytes = Buffer.from(match![2]!, 'base64');
    const sentDims = sniffImageDimensions(sentBytes);
    expect(Math.max(sentDims!.width, sentDims!.height)).toBeLessThanOrEqual(2000);

    // The <system> note keeps the ORIGINAL size so coordinate mapping holds.
    const systemText = noteText(result);
    expect(systemText).toContain('2200x2200');
    expect(systemText).toContain(`${String(big.length)} bytes`);
  });

  it('reports an EXIF-rotated original in the decoded coordinate space', async () => {
    // Orientation 6 (rotate 90° CW): the header says 2200x1100, but jimp
    // decodes to 1100x2200 — the space the sent image and any region
    // readback live in. The note's original size must match that space,
    // not the pre-rotation header sniff.
    const portrait = withExifOrientation(
      new Uint8Array(
        await new Jimp({ width: 2200, height: 1100, color: 0x3366ccff }).getBuffer('image/jpeg', {
          quality: 90,
        }),
      ),
      6,
    );
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: portrait.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(portrait),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_exif',
      args: { path: '/workspace/portrait.jpg' },
      signal,
    });

    const systemText = noteText(result);
    expect(systemText).toContain('Original dimensions: 1100x2200');
    expect(systemText).toMatch(/downsampled to 1000x2000/);
  });

  it('reports the decoded size for a region read of an EXIF-rotated image', async () => {
    // Region coordinates live in the decoded (rotated) space; the note's
    // original size must agree with it even when the header sniff succeeds.
    const portrait = withExifOrientation(
      new Uint8Array(
        await new Jimp({ width: 120, height: 80, color: 0x3366ccff }).getBuffer('image/jpeg', {
          quality: 90,
        }),
      ),
      6,
    );
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: portrait.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(portrait),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_exif_region',
      args: { path: '/workspace/portrait.jpg', region: { x: 0, y: 0, width: 40, height: 40 } },
      signal,
    });

    expect(noteText(result)).toContain('Original dimensions: 80x120');
  });

  it('reports display-space dimensions for an EXIF-rotated image sent untouched', async () => {
    // Within both budgets the original bytes are sent without decoding; the
    // note must still report the display-space size so coordinates derived
    // from it agree with a later region readback (which decodes).
    const portrait = withExifOrientation(
      new Uint8Array(
        await new Jimp({ width: 120, height: 80, color: 0x3366ccff }).getBuffer('image/jpeg', {
          quality: 90,
        }),
      ),
      6,
    );
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: portrait.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(portrait),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_exif_untouched',
      args: { path: '/workspace/portrait.jpg' },
      signal,
    });

    const systemText = noteText(result);
    expect(systemText).toContain('Original dimensions: 80x120');
    expect(systemText).not.toMatch(/downsampled/i);
  });

  it('emits image_compress and image_crop telemetry tagged read_media', async () => {
    const events: { event: string; props: Record<string, unknown> }[] = [];
    const telemetry: TelemetryClient = {
      track: (event, props) => events.push({ event, props: props ?? {} }),
    };
    const big = Buffer.from(
      await new Jimp({ width: 2200, height: 1100, color: 0x3366ccff }).getBuffer('image/png'),
    );
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: big.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(big),
      telemetry,
    });

    await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_tele_read',
      args: { path: '/workspace/big.png' },
      signal,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('image_compress');
    expect(events[0]!.props['source']).toBe('read_media');
    expect(events[0]!.props['outcome']).toBe('compressed');

    await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_tele_crop',
      args: { path: '/workspace/big.png', region: { x: 0, y: 0, width: 100, height: 100 } },
      signal,
    });
    expect(events).toHaveLength(2);
    expect(events[1]!.event).toBe('image_crop');
    expect(events[1]!.props['source']).toBe('read_media');
    expect(events[1]!.props['ok']).toBe(true);
  });

  describe('region and full_resolution', () => {
    async function bigPng(width: number, height: number): Promise<Buffer> {
      return Buffer.from(
        await new Jimp({ width, height, color: 0x3366ccff }).getBuffer('image/png'),
      );
    }

    function toolFor(data: Buffer, imageLimits?: ImageLimits): ReadMediaFileTool {
      return makeReadMediaTool({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
        readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
        imageLimits,
      });
    }

    it('accepts region and full_resolution in the input schema', () => {
      expect(
        ReadMediaFileInputSchema.safeParse({
          path: 'a.png',
          region: { x: 0, y: 0, width: 10, height: 10 },
        }).success,
      ).toBe(true);
      expect(
        ReadMediaFileInputSchema.safeParse({ path: 'a.png', full_resolution: true }).success,
      ).toBe(true);
      expect(
        ReadMediaFileInputSchema.safeParse({
          path: 'a.png',
          region: { x: -1, y: 0, width: 10, height: 10 },
        }).success,
      ).toBe(false);
      expect(
        ReadMediaFileInputSchema.safeParse({
          path: 'a.png',
          region: { x: 0, y: 0, width: 0, height: 10 },
        }).success,
      ).toBe(false);
    });

    it('announces a downsampled delivery and the region readback in the <system> block', async () => {
      const big = await bigPng(2200, 2200);
      const result = await executeTool(toolFor(big), {
        turnId: 't1',
        toolCallId: 'c_note',
        args: { path: '/workspace/big.png' },
        signal,
      });

      const systemText = noteText(result);
      expect(systemText).toContain('2200x2200');
      // Wording must not depend on serialization order: some providers keep
      // the note inline after the media, others flatten tool text and
      // re-attach the image after it — so no "above"/"below".
      expect(systemText).toMatch(/The attached image was downsampled to 2000x2000/);
      expect(systemText).toMatch(/fine detail/i);
      expect(systemText).toContain('region');
    });

    it('does not claim downsampling for an image sent untouched', async () => {
      // A real 3x4 PNG passes through unchanged — the <system> block must not
      // carry a downsample note (that would be its own kind of misreporting).
      const png = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000030000000408020000003a' +
          '63dc1c0000001949444154789c63606060f8cf80019aa0a8a020' +
          '00000000ffff03000c1d03014b0000000049454e44ae426082',
        'hex',
      );
      const result = await executeTool(toolFor(png), {
        turnId: 't1',
        toolCallId: 'c_untouched',
        args: { path: '/workspace/small.png' },
        signal,
      });
      const systemText = noteText(result);
      expect(systemText).not.toMatch(/downsampled/i);
    });

    it('reads a region crop at native resolution', async () => {
      // Over the 2000px edge cap on purpose: region reads must crop from the
      // original coordinate space, which a sub-cap fixture cannot distinguish
      // from cropping the downsampled delivery.
      const big = await bigPng(2100, 2100);
      const result = await executeTool(toolFor(big), {
        turnId: 't1',
        toolCallId: 'c_crop',
        args: { path: '/workspace/big.png', region: { x: 100, y: 50, width: 400, height: 300 } },
        signal,
      });

      const parts = outputParts(result);
      const url = (parts[1] as { imageUrl: { url: string } }).imageUrl.url;
      const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(url);
      const sentDims = sniffImageDimensions(Buffer.from(match![2]!, 'base64'));
      expect(sentDims).toEqual({ width: 400, height: 300 });

      const systemText = noteText(result);
      expect(systemText).toContain('2100x2100');
      expect(systemText).toMatch(/region \(x=100, y=50, width=400, height=300\)/);
      expect(systemText).toMatch(/native resolution/);
      expect(systemText).toContain('offset');
    });

    it('rejects a region outside the image with the original size in the error', async () => {
      // Over the edge cap so "original size" is distinguishable from any
      // downsampled delivery size.
      const big = await bigPng(2100, 2100);
      const result = await executeTool(toolFor(big), {
        turnId: 't1',
        toolCallId: 'c_crop_oob',
        args: { path: '/workspace/big.png', region: { x: 5000, y: 0, width: 100, height: 100 } },
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('2100x2100');
    });

    it('serves full_resolution when the bytes fit the per-image budget', async () => {
      const big = await bigPng(2100, 1050); // over the edge cap, tiny in bytes
      const result = await executeTool(toolFor(big), {
        turnId: 't1',
        toolCallId: 'c_fullres',
        args: { path: '/workspace/big.png', full_resolution: true },
        signal,
      });

      const parts = outputParts(result);
      expect((parts[1] as { imageUrl: { url: string } }).imageUrl.url).toBe(
        `data:image/png;base64,${big.toString('base64')}`,
      );
      const systemText = noteText(result);
      expect(systemText).toMatch(/native resolution/);
    });

    it('returns the full_resolution limit error before loading an over-budget image', async () => {
      // PNG magic followed by 4MB of filler: recognizably an image, over the
      // 3.75MB byte budget — full_resolution must refuse, not silently shrink.
      const data = Buffer.concat([PNG_HEADER, Buffer.alloc(4 * 1024 * 1024, 1)]);
      const readBytes = vi.fn<Kaos['readBytes']>(async (_path, n) =>
        n === undefined ? data : data.subarray(0, n),
      );
      const tool = makeReadMediaTool({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
        readBytes,
      });

      const result = await executeTool(tool, {
        turnId: 't1',
        toolCallId: 'c_fullres_big',
        args: { path: '/workspace/huge.png', full_resolution: true },
        signal,
      });

      expect(result).toEqual({
        isError: true,
        output:
          '"/workspace/huge.png" is 4194312 bytes (4.0 MB), over the 3932160-byte (3.8 MB) ' +
          'per-image limit, so full_resolution cannot be honored. ' +
          'Use region to view a crop at full fidelity instead.',
      });
      expect(readBytes).toHaveBeenCalledOnce();
      expect(readBytes).toHaveBeenCalledWith('/workspace/huge.png', MEDIA_SNIFF_BYTES);
    });

    it('returns external preprocessing guidance before loading an oversized region source', async () => {
      const readBytes = vi.fn<Kaos['readBytes']>().mockResolvedValue(PNG_HEADER);
      const tool = makeReadMediaTool({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({
          ...DEFAULT_STAT,
          stSize: MAX_IMAGE_DECODE_BYTES + 1,
        }),
        readBytes,
      });

      const result = await executeTool(tool, {
        turnId: 't1',
        toolCallId: 'c_region_decode_guard',
        args: {
          path: '/workspace/huge.png',
          region: { x: 0, y: 0, width: 100, height: 100 },
        },
        signal,
      });

      expect(result).toEqual({
        isError: true,
        output:
          'Image is too large to process safely for region or full_resolution (67108865 bytes; ' +
          'safe decode limit 67108864 bytes). The original image was not sent to the model. Do ' +
          'not retry the same file unchanged. Use Bash or an available image-processing tool to ' +
          'create a smaller copy or crop the needed region into a separate image, then call ' +
          'ReadMediaFile on the resulting file.',
      });
      expect(readBytes).toHaveBeenCalledOnce();
      expect(readBytes).toHaveBeenCalledWith('/workspace/huge.png', MEDIA_SNIFF_BYTES);
    });

    it('prioritizes external preprocessing guidance for full_resolution above the decode cap', async () => {
      const readBytes = vi.fn<Kaos['readBytes']>().mockResolvedValue(PNG_HEADER);
      const tool = makeReadMediaTool({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({
          ...DEFAULT_STAT,
          stSize: MAX_IMAGE_DECODE_BYTES + 1,
        }),
        readBytes,
      });

      const result = await executeTool(tool, {
        turnId: 't1',
        toolCallId: 'c_fullres_decode_guard',
        args: { path: '/workspace/huge.png', full_resolution: true },
        signal,
      });

      expect(result.output).toBe(
        'Image is too large to process safely for region or full_resolution (67108865 bytes; ' +
          'safe decode limit 67108864 bytes). The original image was not sent to the model. Do ' +
          'not retry the same file unchanged. Use Bash or an available image-processing tool to ' +
          'create a smaller copy or crop the needed region into a separate image, then call ' +
          'ReadMediaFile on the resulting file.',
      );
      expect(result.isError).toBe(true);
      expect(readBytes).toHaveBeenCalledOnce();
      expect(readBytes).toHaveBeenCalledWith('/workspace/huge.png', MEDIA_SNIFF_BYTES);
    });

    it('rejects region and full_resolution for video files', async () => {
      const tool = makeReadMediaTool({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({
          ...DEFAULT_STAT,
          stSize: MP4_HEADER.length,
        }),
        readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(MP4_HEADER),
      });

      const withRegion = await executeTool(tool, {
        turnId: 't1',
        toolCallId: 'c_vid_region',
        args: { path: '/workspace/clip.mp4', region: { x: 0, y: 0, width: 10, height: 10 } },
        signal,
      });
      expect(withRegion.isError).toBe(true);
      expect(withRegion.output).toMatch(/image files/i);

      const withFullRes = await executeTool(tool, {
        turnId: 't1',
        toolCallId: 'c_vid_fullres',
        args: { path: '/workspace/clip.mp4', full_resolution: true },
        signal,
      });
      expect(withFullRes.isError).toBe(true);
    });
  });

  describe('provider-unsupported formats', () => {
    /** Minimal ISO-BMFF header: size + 'ftyp' + the given brand. */
    function ftypHeader(brand: string): Buffer {
      const bytes = Buffer.alloc(16);
      bytes.writeUInt32BE(16, 0);
      bytes.write('ftyp', 4, 'latin1');
      bytes.write(brand, 8, 'latin1');
      return bytes;
    }

    function unsupportedTool(osKind: string, data: Buffer): ReadMediaFileTool {
      const kaos = createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
        readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
        osEnv: { ...FAKE_OS_ENV, osKind },
      });
      return new ReadMediaFileTool(kaos, PERMISSIVE_WORKSPACE, capabilities());
    }

    function heicTool(osKind: string, brand = 'heic'): ReadMediaFileTool {
      return unsupportedTool(osKind, ftypHeader(brand));
    }

    it('refuses HEIC with sips guidance on macOS instead of sending it to the provider', async () => {
      const result = await executeTool(heicTool('macOS'), {
        turnId: 't1',
        toolCallId: 'c_heic_mac',
        args: { path: '/workspace/photo.HEIC' },
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('image/heic');
      expect(result.output).toContain('sips -s format jpeg');
      expect(result.output).toContain('/workspace/photo.jpg');
    });

    it('refuses HEIC with heif-convert / ImageMagick guidance on Linux', async () => {
      const result = await executeTool(heicTool('Linux'), {
        turnId: 't1',
        toolCallId: 'c_heic_linux',
        args: { path: '/workspace/photo.HEIC' },
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('heif-convert');
      expect(result.output).toContain('magick');
    });

    it('refuses HEIC with ImageMagick guidance on Windows', async () => {
      const result = await executeTool(heicTool('Windows'), {
        turnId: 't1',
        toolCallId: 'c_heic_win',
        args: { path: '/workspace/photo.HEIC' },
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('magick');
      expect(result.output).toContain('winget');
    });

    it('refuses HEIF brands and region reads the same way', async () => {
      const heif = await executeTool(heicTool('macOS', 'mif1'), {
        turnId: 't1',
        toolCallId: 'c_heif',
        args: { path: '/workspace/photo.heif' },
        signal,
      });
      expect(heif.isError).toBe(true);
      expect(heif.output).toContain('image/heif');

      const region = await executeTool(heicTool('macOS'), {
        turnId: 't1',
        toolCallId: 'c_heic_region',
        args: { path: '/workspace/photo.HEIC', region: { x: 0, y: 0, width: 10, height: 10 } },
        signal,
      });
      expect(region.isError).toBe(true);
      expect(region.output).toContain('sips');
    });

    it('refuses AVIF (still and animated brands) with conversion guidance', async () => {
      for (const brand of ['avif', 'avis']) {
        const result = await executeTool(unsupportedTool('macOS', ftypHeader(brand)), {
          turnId: 't1',
          toolCallId: `c_avif_${brand}`,
          args: { path: '/workspace/photo.avif' },
          signal,
        });
        expect(result.isError).toBe(true);
        expect(result.output).toContain('image/avif');
        expect(result.output).toContain('sips -s format jpeg');
        expect(result.output).toContain('/workspace/photo.jpg');
      }
    });

    it('refuses AVIF on Linux with ImageMagick guidance (no heif-convert)', async () => {
      const result = await executeTool(unsupportedTool('Linux', ftypHeader('avif')), {
        turnId: 't1',
        toolCallId: 'c_avif_linux',
        args: { path: '/workspace/photo.avif' },
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('magick');
      expect(result.output).not.toContain('heif-convert');
    });

    it('refuses BMP, TIFF, and ICO with per-OS conversion guidance', async () => {
      const cases: readonly { data: Buffer; mime: string; path: string }[] = [
        { data: Buffer.concat([Buffer.from('BM'), Buffer.from('bmpdata')]), mime: 'image/bmp', path: '/workspace/photo.bmp' },
        { data: Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x00]), mime: 'image/tiff', path: '/workspace/scan.tiff' },
        { data: Buffer.from([0x00, 0x00, 0x01, 0x00, 0x00]), mime: 'image/x-icon', path: '/workspace/favicon.ico' },
      ];
      for (const c of cases) {
        const result = await executeTool(unsupportedTool('macOS', c.data), {
          turnId: 't1',
          toolCallId: `c_${c.mime.replace('/', '_')}`,
          args: { path: c.path },
          signal,
        });
        expect(result.isError).toBe(true);
        expect(result.output).toContain(c.mime);
        expect(result.output).toContain('sips');
      }
    });
  });

  describe('read byte budget', () => {
    /** High-entropy PNG whose bytes stay large after downscaling. */
    async function noisePng(width: number, height: number): Promise<Buffer> {
      const image = new Jimp({ width, height, color: 0x000000ff });
      const data = image.bitmap.data;
      let state = 0x9e3779b9;
      for (let i = 0; i < data.length; i += 4) {
        state ^= (state << 13) >>> 0;
        state ^= state >>> 17;
        state ^= (state << 5) >>> 0;
        state >>>= 0;
        data[i] = state & 0xff;
        data[i + 1] = (state >>> 8) & 0xff;
        data[i + 2] = (state >>> 16) & 0xff;
        data[i + 3] = 0xff;
      }
      return Buffer.from(await image.getBuffer('image/png'));
    }

    function toolFor(data: Buffer, imageLimits?: ImageLimits): ReadMediaFileTool {
      return makeReadMediaTool({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
        readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
        imageLimits,
      });
    }

    function sentBytes(result: Awaited<ReturnType<typeof executeTool>>): Buffer {
      const parts = outputParts(result);
      const url = (parts[1] as { imageUrl: { url: string } }).imageUrl.url;
      const match = /^data:image\/[a-z]+;base64,(.+)$/.exec(url);
      expect(match).not.toBeNull();
      return Buffer.from(match![1]!, 'base64');
    }

    it(
      'compresses a default read to fit the configured read budget',
      async () => {
        const budget = 64 * 1024;
        const limits = new ImageLimits(process.env, { readByteBudget: budget });
        const data = await noisePng(400, 400);
        expect(data.length).toBeGreaterThan(budget);

        const result = await executeTool(toolFor(data, limits), {
          turnId: 't1',
          toolCallId: 'c_budget',
          args: { path: '/workspace/noisy.png' },
          signal,
        });

        expect(result.isError).toBe(false);
        expect(sentBytes(result).length).toBeLessThanOrEqual(budget);
        expect(noteText(result)).toMatch(/downsampled/);
      },
      15_000,
    );

    it('returns shrink guidance without attaching the original when a decode guard blocks compression', async () => {
      const data = Buffer.alloc(24);
      PNG_HEADER.copy(data);
      data.writeUInt32BE(10_001, 16);
      data.writeUInt32BE(10_000, 20);

      const result = await executeTool(toolFor(data), {
        turnId: 't1',
        toolCallId: 'c_guarded_read',
        args: { path: '/workspace/pixel-bomb.png' },
        signal,
      });

      expect(result.isError).toBe(true);
      expect(result.output).toBe(
        'Image is too large to send safely after compression (24 bytes; limit 262144 bytes and ' +
          '2000px on the longest edge). The original image was not sent to the model. ' +
          'Do not retry the same file unchanged. Use Bash or an available image-processing tool ' +
          'to create a smaller copy within both limits, then call ReadMediaFile on the smaller copy.',
      );
      expect(JSON.stringify(result)).not.toMatch(/image_url|blobref|base64|region/);
    });

    it('returns shrink guidance before loading a default image that exceeds the decode byte guard', async () => {
      const readBytes = vi.fn<Kaos['readBytes']>().mockResolvedValue(PNG_HEADER);
      const tool = makeReadMediaTool({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({
          ...DEFAULT_STAT,
          stSize: MAX_IMAGE_DECODE_BYTES + 1,
        }),
        readBytes,
      });

      const result = await executeTool(tool, {
        turnId: 't1',
        toolCallId: 'c_byte_guarded_read',
        args: { path: '/workspace/huge.png' },
        signal,
      });

      expect(result.isError).toBe(true);
      expect(result.output).toBe(
        'Image is too large to send safely after compression (67108865 bytes; limit 262144 bytes ' +
          'and 2000px on the longest edge). The original image was not sent to the model. Do not ' +
          'retry the same file unchanged. Use Bash or an available image-processing tool to create ' +
          'a smaller copy within both limits, then call ReadMediaFile on the smaller copy.',
      );
      expect(readBytes).toHaveBeenCalledTimes(1);
      expect(readBytes).toHaveBeenCalledWith('/workspace/huge.png', MEDIA_SNIFF_BYTES);
    });

    it('continues to the full read when an over-guard image fits the configured byte budget', async () => {
      const png = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000030000000408020000003a' +
          '63dc1c0000001949444154789c63606060f8cf80019aa0a8a020' +
          '00000000ffff03000c1d03014b0000000049454e44ae426082',
        'hex',
      );
      const readBytes = vi.fn<Kaos['readBytes']>().mockResolvedValue(png);
      const tool = makeReadMediaTool({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({
          ...DEFAULT_STAT,
          stSize: MAX_IMAGE_DECODE_BYTES + 1,
        }),
        readBytes,
        imageLimits: new ImageLimits(process.env, {
          readByteBudget: MAX_IMAGE_DECODE_BYTES + 2,
        }),
      });

      const result = await executeTool(tool, {
        turnId: 't1',
        toolCallId: 'c_over_guard_with_budget',
        args: { path: '/workspace/large-budget.png' },
        signal,
      });

      expect(result.isError).toBe(false);
      expect(readBytes).toHaveBeenNthCalledWith(
        1,
        '/workspace/large-budget.png',
        MEDIA_SNIFF_BYTES,
      );
      expect(readBytes).toHaveBeenNthCalledWith(2, '/workspace/large-budget.png');
    });

    it('returns shrink guidance without attaching bytes when codec failure leaves the image over budget', async () => {
      const data = Buffer.concat([PNG_HEADER, Buffer.from([0x00])]);
      const limits = new ImageLimits(process.env, { readByteBudget: 8 });

      const result = await executeTool(toolFor(data, limits), {
        turnId: 't1',
        toolCallId: 'c_codec_failure',
        args: { path: '/workspace/broken.png' },
        signal,
      });

      expect(result.isError).toBe(true);
      expect(result.output).toBe(
        'Image is too large to send safely after compression (9 bytes; limit 8 bytes and 2000px ' +
          'on the longest edge). The original image was not sent to the model. Do not retry the ' +
          'same file unchanged. Use Bash or an available image-processing tool to create a smaller ' +
          'copy within both limits, then call ReadMediaFile on the smaller copy.',
      );
      expect(JSON.stringify(result)).not.toMatch(/image_url|blobref|base64|region/);
    });

    it('full_resolution ignores the read budget (per-image provider limit applies)', async () => {
      const limits = new ImageLimits(process.env, { readByteBudget: 64 * 1024 });
      const data = await noisePng(300, 300);
      expect(data.length).toBeGreaterThan(64 * 1024);

      const result = await executeTool(toolFor(data, limits), {
        turnId: 't1',
        toolCallId: 'c_fullres_budget',
        args: { path: '/workspace/noisy.png', full_resolution: true },
        signal,
      });

      expect(result.isError).toBe(false);
      // Delivered byte-for-byte: the read budget must not shrink the
      // full-fidelity escape hatch the downsample note promises.
      expect(sentBytes(result).equals(data)).toBe(true);
    });

    it(
      'region reads ignore the read budget so detail readback stays full-fidelity',
      async () => {
        const limits = new ImageLimits(process.env, { readByteBudget: 16 * 1024 });
        const data = await noisePng(500, 500);

        const result = await executeTool(toolFor(data, limits), {
          turnId: 't1',
          toolCallId: 'c_region_budget',
          args: { path: '/workspace/noisy.png', region: { x: 0, y: 0, width: 400, height: 400 } },
          signal,
        });

        expect(result.isError).toBe(false);
        // A native-resolution noise crop is far larger than the read budget;
        // it must still be delivered under the provider-scale budget.
        expect(sentBytes(result).length).toBeGreaterThan(16 * 1024);
      },
      15_000,
    );

    it(
      'two tools honor their own limits independently (no shared process state)',
      async () => {
        const data = await noisePng(512, 512);
        const tight = toolFor(data, new ImageLimits(process.env, { readByteBudget: 48 * 1024 }));
        const roomy = toolFor(data, new ImageLimits(process.env, { maxEdgePx: 1200 }));

        const tightResult = await executeTool(tight, {
          turnId: 't1',
          toolCallId: 'c_iso_tight',
          args: { path: '/workspace/noisy.png' },
          signal,
        });
        const roomyResult = await executeTool(roomy, {
          turnId: 't1',
          toolCallId: 'c_iso_roomy',
          args: { path: '/workspace/noisy.png' },
          signal,
        });

        expect(sentBytes(tightResult).length).toBeLessThanOrEqual(48 * 1024);
        // The roomy tool keeps the default 256 KB budget and its own edge cap:
        // its output is far larger than the tight tool's budget.
        expect(sentBytes(roomyResult).length).toBeGreaterThan(48 * 1024);
      },
      15_000,
    );
  });
});
