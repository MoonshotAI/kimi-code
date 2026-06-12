/**
 * ReadTool media-path tests — image/video output envelope, capability
 * gating, size limits, the video upload hook, and the capability-driven
 * tool description.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import type { ContentPart, ModelCapability } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import { ToolAccesses } from '../../src/loop';
import type { ExecutableToolResult } from '../../src/loop';
import { ReadInputSchema, ReadTool } from '../../src/tools/builtin/file/read';
import { MEDIA_SNIFF_BYTES } from '../../src/tools/support/file-type';
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
    readonly readLines?: Kaos['readLines'] | undefined;
    readonly modelCapabilities?: ModelCapability | undefined;
  } = {},
): ReadTool {
  const kaos = createFakeKaos({
    stat: input.stat ?? vi.fn<Kaos['stat']>().mockResolvedValue(DEFAULT_STAT),
    readBytes: input.readBytes ?? vi.fn<Kaos['readBytes']>().mockResolvedValue(PNG_HEADER),
    readLines: input.readLines,
  });
  return new ReadTool(kaos, PERMISSIVE_WORKSPACE, input.modelCapabilities ?? capabilities());
}

function outputParts(result: ExecutableToolResult): ContentPart[] {
  expect(result.isError).toBeFalsy();
  expect(Array.isArray(result.output)).toBe(true);
  return result.output as ContentPart[];
}

describe('ReadTool media path', () => {
  it('has name, parameters, and path-scoped resource accesses', () => {
    const tool = makeReadMediaTool();

    expect(tool.name).toBe('Read');
    expect(ReadInputSchema.safeParse({ path: '/workspace/sample.png' }).success).toBe(true);
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
    // The useful "directories are not supported" note stays.
    expect(description).toMatch(/directories are not supported/i);
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

  it('sniffs media from raw bytes before ACP text preview', async () => {
    const data = Buffer.concat([PNG_HEADER, Buffer.from('pngdata')]);
    const readTextPreview = vi.fn(async () => {
      throw new Error('ACP text preview must not be used for media sniffing');
    });
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
        readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
        readTextPreview,
      } as unknown as Partial<Kaos>),
      PERMISSIVE_WORKSPACE,
      capabilities(),
    );

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_acp_media',
      args: { path: '/workspace/sample.png' },
      signal,
    });

    const parts = outputParts(result);
    expect(parts[2]).toMatchObject({ type: 'image_url' });
    expect(readTextPreview).not.toHaveBeenCalled();
  });

  it('ignores pagination parameters for media files', async () => {
    const data = Buffer.concat([PNG_HEADER, Buffer.from('pngdata')]);
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: data.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_page',
      args: { path: '/workspace/sample.png', line_offset: 10, n_lines: 5 },
      signal,
    });

    const parts = outputParts(result);
    expect(parts).toHaveLength(4);
    expect(parts[2]).toMatchObject({ type: 'image_url' });
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

  it('uses injected videoUploader for video files when available', async () => {
    const videoUploader = vi.fn().mockResolvedValue({
      type: 'video_url',
      videoUrl: { url: 'ms://file-123', id: 'file-123' },
    });
    const tool = new ReadTool(
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

  it('reports the file path when the video upload fails', async () => {
    // A bare provider error ("404 route not found") tells the model and
    // the user nothing about which file or which step failed; the media
    // path must wrap it with read context.
    const videoUploader = vi.fn().mockRejectedValue(new Error('404 route not found'));
    const tool = new ReadTool(
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
      toolCallId: 'c_upload_fail',
      args: { path: '/workspace/clip.mov' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Failed to read /workspace/clip.mov');
    expect(result.output).toContain('404 route not found');
  });

  it('reads text files as numbered lines through the same tool', async () => {
    const text = 'hello\n';
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: text.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(Buffer.from(text)),
      readLines: vi.fn<Kaos['readLines']>().mockImplementation(async function* readLines() {
        yield 'hello\n';
      }),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c5',
      args: { path: '/workspace/sample.txt' },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1\thello');
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
      '"/workspace/blob.bin" is not readable as UTF-8 text. ' +
        'For binary formats, use Bash or an MCP tool if available.',
    );
    expect(result.output).not.toContain('Python tools');
  });

  it('errors when the current model lacks image input capability', async () => {
    const tool = makeReadMediaTool({
      modelCapabilities: capabilities({ image_in: false, video_in: true }),
    });

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_noimg',
      args: { path: '/workspace/sample.png' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/image input/i);
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
    const empty = await executeTool(
      makeReadMediaTool({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: 0 }),
      }),
      {
        turnId: 't1',
        toolCallId: 'c_empty',
        args: { path: '/workspace/empty.png' },
        signal,
      },
    );
    expect(empty).toMatchObject({ isError: true });
    expect(empty.output).toMatch(/empty/i);

    const huge = await executeTool(
      makeReadMediaTool({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue({
          ...DEFAULT_STAT,
          stSize: 200 * 1024 * 1024,
        }),
      }),
      {
        turnId: 't1',
        toolCallId: 'c_huge',
        args: { path: '/workspace/huge.png' },
        signal,
      },
    );
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

    const result = await executeTool(tool, {
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

    const result = await executeTool(tool, {
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

  it('allows absolute media paths outside workspace but rejects relative escapes', async () => {
    const readBytes = vi.fn<Kaos['readBytes']>().mockResolvedValue(PNG_HEADER);
    const tool = new ReadTool(
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
});

describe('ReadTool description by capabilities', () => {
  function makeTool(caps: Partial<ModelCapability>): ReadTool {
    return new ReadTool(createFakeKaos(), PERMISSIVE_WORKSPACE, capabilities(caps));
  }

  it('mentions image and video when both capabilities are present', () => {
    const tool = makeTool({ image_in: true, video_in: true });
    expect(tool.description).toContain('supports image and video');
  });

  it('mentions image but flags video unsupported when only image_in is present', () => {
    const tool = makeTool({ image_in: true, video_in: false });
    expect(tool.description).toContain('supports image files for the current model');
    expect(tool.description).toContain('Video files are not supported');
  });

  it('mentions video but flags image unsupported when only video_in is present', () => {
    const tool = makeTool({ image_in: false, video_in: true });
    expect(tool.description).toContain('supports video files for the current model');
    expect(tool.description).toContain('Image files are not supported');
  });

  it('declares media unsupported when neither capability is present', () => {
    const tool = makeTool({ image_in: false, video_in: false });
    expect(tool.description).toContain('does not support image or video input');
  });

  it('description pins the stable contract phrases: image+video, 100MB, parallel reads', () => {
    const tool = makeTool({ image_in: true, video_in: true });
    expect(tool.description).toContain('image and video');
    expect(tool.description).toContain('100MB');
    expect(tool.description).toContain('parallel');
  });
});
