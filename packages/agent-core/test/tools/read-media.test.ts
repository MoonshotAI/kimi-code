/**
 * ReadMediaFileTool tests for the current output/capability contract.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import type { ContentPart, ModelCapability } from '@moonshot-ai/kosong';
import { Jimp } from 'jimp';
import { describe, expect, it, vi } from 'vitest';

import { ToolAccesses } from '../../src/loop';
import type { ExecutableToolResult } from '../../src/loop';
import {
  ReadMediaFileInputSchema,
  ReadMediaFileTool,
} from '../../src/tools/builtin/file/read-media';
import { MEDIA_SNIFF_BYTES, sniffImageDimensions } from '../../src/tools/support/file-type';
import { createFakeKaos, PERMISSIVE_WORKSPACE } from './fixtures/fake-kaos';
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
  );
}

function outputParts(result: ExecutableToolResult): ContentPart[] {
  expect(result.isError).toBeFalsy();
  expect(Array.isArray(result.output)).toBe(true);
  return result.output as ContentPart[];
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

  it('returns a system/text/image/text wrap for PNG files', async () => {
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

    const parts = outputParts(result);
    expect(parts).toHaveLength(4);
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((parts[0] as { text: string }).text).toMatch(/^<system>.*<\/system>$/s);
    expect(parts[1]).toEqual({ type: 'text', text: '<image path="/workspace/sample.png">' });
    expect(parts[2]).toMatchObject({ type: 'image_url' });
    expect((parts[2] as { imageUrl: { url: string } }).imageUrl.url).toBe(
      `data:image/png;base64,${data.toString('base64')}`,
    );
    expect(parts[3]).toEqual({ type: 'text', text: '</image>' });
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

    const parts = outputParts(result);
    const systemText = (parts[0] as { text: string }).text;
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

    const parts = outputParts(result);
    const systemText = (parts[0] as { text: string }).text;
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

    const parts = outputParts(result);
    const systemText = (parts[0] as { text: string }).text;
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

    const parts = outputParts(result);
    const systemText = (parts[0] as { text: string }).text;
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
    expect(parts[1]).toEqual({ type: 'text', text: '<image path="/workspace/sample">' });
    expect((parts[2] as { imageUrl: { url: string } }).imageUrl.url).toContain('image/png');
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
    expect(parts[1]).toEqual({ type: 'text', text: '<image path="/home/test/images/sample.png">' });
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

    const parts = outputParts(result);
    expect(parts).toHaveLength(4);
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((parts[0] as { text: string }).text).toMatch(/^<system>.*<\/system>$/s);
    expect(parts[1]).toEqual({ type: 'text', text: '<video path="/workspace/sample.mp4">' });
    expect(parts[2]).toMatchObject({ type: 'video_url' });
    expect((parts[2] as { videoUrl: { url: string } }).videoUrl.url).toBe(
      `data:video/mp4;base64,${MP4_HEADER.toString('base64')}`,
    );
    expect(parts[3]).toEqual({ type: 'text', text: '</video>' });
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
    expect(parts[1]).toEqual({ type: 'text', text: '<video path="/workspace/sample.mpg">' });
    expect((parts[2] as { videoUrl: { url: string } }).videoUrl.url).toBe(
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
    expect(parts[2]).toEqual({
      type: 'video_url',
      videoUrl: { url: 'ms://file-123', id: 'file-123' },
    });
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

    const parts = outputParts(result);
    const systemText = (parts[0] as { text: string }).text;
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

    const parts = outputParts(result);
    const systemText = (parts[0] as { text: string }).text;
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
    expect((parts[2] as { imageUrl: { url: string } }).imageUrl.url).toBe(
      `data:image/jpeg;base64,${data.toString('base64')}`,
    );
  });

  it('ships sniffed image formats to the provider without gating', async () => {
    // A `.png` file that is actually a BMP is reported as `image/bmp`. The
    // tool does not gate on image format — it ships the real bytes with the
    // sniffed MIME, and the provider decides which formats it accepts.
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

    const parts = outputParts(result);
    expect((parts[2] as { imageUrl: { url: string } }).imageUrl.url).toBe(
      `data:image/bmp;base64,${data.toString('base64')}`,
    );
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
      await new Jimp({ width: 2600, height: 2600, color: 0x3366ccff }).getBuffer('image/png'),
    );
    expect(sniffImageDimensions(big)).toEqual({ width: 2600, height: 2600 });

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
    const url = (parts[2] as { imageUrl: { url: string } }).imageUrl.url;
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(url);
    expect(match).not.toBeNull();
    // The image actually sent to the model is downsampled to the edge cap.
    const sentBytes = Buffer.from(match![2]!, 'base64');
    const sentDims = sniffImageDimensions(sentBytes);
    expect(Math.max(sentDims!.width, sentDims!.height)).toBeLessThanOrEqual(2000);

    // The <system> summary keeps the ORIGINAL size so coordinate mapping holds.
    const systemText = (parts[0] as { text: string }).text;
    expect(systemText).toContain('2600x2600');
    expect(systemText).toContain(`${String(big.length)} bytes`);
  });

  describe('region and full_resolution', () => {
    async function bigPng(width: number, height: number): Promise<Buffer> {
      return Buffer.from(
        await new Jimp({ width, height, color: 0x3366ccff }).getBuffer('image/png'),
      );
    }

    function toolFor(data: Buffer): ReadMediaFileTool {
      return makeReadMediaTool({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
        readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
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
      const big = await bigPng(2600, 2600);
      const result = await executeTool(toolFor(big), {
        turnId: 't1',
        toolCallId: 'c_note',
        args: { path: '/workspace/big.png' },
        signal,
      });

      const parts = outputParts(result);
      const systemText = (parts[0] as { text: string }).text;
      expect(systemText).toContain('2600x2600');
      expect(systemText).toMatch(/downsampled to 2000x2000/);
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
      const parts = outputParts(result);
      const systemText = (parts[0] as { text: string }).text;
      expect(systemText).not.toMatch(/downsampled/i);
    });

    it('reads a region crop at native resolution', async () => {
      const big = await bigPng(2600, 2600);
      const result = await executeTool(toolFor(big), {
        turnId: 't1',
        toolCallId: 'c_crop',
        args: { path: '/workspace/big.png', region: { x: 100, y: 50, width: 400, height: 300 } },
        signal,
      });

      const parts = outputParts(result);
      const url = (parts[2] as { imageUrl: { url: string } }).imageUrl.url;
      const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(url);
      const sentDims = sniffImageDimensions(Buffer.from(match![2]!, 'base64'));
      expect(sentDims).toEqual({ width: 400, height: 300 });

      const systemText = (parts[0] as { text: string }).text;
      expect(systemText).toContain('2600x2600');
      expect(systemText).toMatch(/region \(x=100, y=50, width=400, height=300\)/);
      expect(systemText).toMatch(/native resolution/);
      expect(systemText).toContain('offset');
    });

    it('rejects a region outside the image with the original size in the error', async () => {
      const big = await bigPng(2600, 2600);
      const result = await executeTool(toolFor(big), {
        turnId: 't1',
        toolCallId: 'c_crop_oob',
        args: { path: '/workspace/big.png', region: { x: 5000, y: 0, width: 100, height: 100 } },
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('2600x2600');
    });

    it('serves full_resolution when the bytes fit the per-image budget', async () => {
      const big = await bigPng(2600, 1300); // over the edge cap, tiny in bytes
      const result = await executeTool(toolFor(big), {
        turnId: 't1',
        toolCallId: 'c_fullres',
        args: { path: '/workspace/big.png', full_resolution: true },
        signal,
      });

      const parts = outputParts(result);
      expect((parts[2] as { imageUrl: { url: string } }).imageUrl.url).toBe(
        `data:image/png;base64,${big.toString('base64')}`,
      );
      const systemText = (parts[0] as { text: string }).text;
      expect(systemText).toMatch(/native resolution/);
    });

    it('fails full_resolution explicitly when the file exceeds the per-image budget', async () => {
      // PNG magic followed by 4MB of filler: recognizably an image, over the
      // 3.75MB byte budget — full_resolution must refuse, not silently shrink.
      const data = Buffer.concat([PNG_HEADER, Buffer.alloc(4 * 1024 * 1024, 1)]);
      const result = await executeTool(toolFor(data), {
        turnId: 't1',
        toolCallId: 'c_fullres_big',
        args: { path: '/workspace/huge.png', full_resolution: true },
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/full_resolution/);
      expect(result.output).toMatch(/region/);
      // Exact byte counts accompany the rounded sizes: a file a hair over
      // budget would otherwise read "is 3.8 MB, over the 3.8 MB limit".
      expect(result.output).toContain(`${String(data.length)} bytes`);
      expect(result.output).toContain('3932160-byte');
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
});
