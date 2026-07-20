import { ContentBlockSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ContentPart } from '@moonshot-ai/kosong';
import { Jimp } from 'jimp';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { convertMCPContentBlock, mcpResultToExecutableOutput } from '../../src/mcp/output';
import type { MCPContentBlock, MCPToolResult } from '../../src/mcp/types';
import type { TelemetryClient } from '../../src/telemetry';
import { sniffImageDimensions } from '../../src/tools/support/file-type';

const MCP_OUTPUT_TRUNCATED_TEXT =
  '\n\n[Output truncated: exceeded 100000 character limit. ' +
  'Use pagination or more specific queries to get remaining content.]';

/**
 * Assert a test fixture matches the MCP SDK's ContentBlock schema. This
 * guards against fixtures that drift from the real protocol shape — exactly
 * the failure mode that previously hid the EmbeddedResource bug.
 */
function assertValidMcpBlock<T extends MCPContentBlock>(block: T): T {
  const parsed = ContentBlockSchema.safeParse(block);
  if (!parsed.success) {
    throw new Error(`fixture is not a valid MCP ContentBlock: ${parsed.error.message}`);
  }
  return block;
}

describe('convertMCPContentBlock', () => {
  test('converts text block to TextPart', () => {
    const block: MCPContentBlock = { type: 'text', text: 'hello' };
    expect(convertMCPContentBlock(block)).toEqual({ type: 'text', text: 'hello' });
  });

  test('converts image block with mimeType to image data URI', () => {
    const block: MCPContentBlock = { type: 'image', data: 'AAA', mimeType: 'image/jpeg' };
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:image/jpeg;base64,AAA' },
    });
  });

  test('image block without mimeType defaults to image/png', () => {
    const block: MCPContentBlock = { type: 'image', data: 'AAA' };
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,AAA' },
    });
  });

  test('converts audio block to AudioURLPart with audio/mpeg default', () => {
    const block: MCPContentBlock = { type: 'audio', data: 'BBB' };
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'audio_url',
      audioUrl: { url: 'data:audio/mpeg;base64,BBB' },
    });
  });

  test('converts audio block with custom mimeType', () => {
    const block: MCPContentBlock = { type: 'audio', data: 'BBB', mimeType: 'audio/wav' };
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'audio_url',
      audioUrl: { url: 'data:audio/wav;base64,BBB' },
    });
  });

  test('converts text EmbeddedResource to TextPart', () => {
    const block = assertValidMcpBlock({
      type: 'resource',
      resource: {
        uri: 'file:///project/src/main.rs',
        mimeType: 'text/x-rust',
        text: 'fn main() {}',
      },
    });
    expect(convertMCPContentBlock(block)).toEqual({ type: 'text', text: 'fn main() {}' });
  });

  test('text EmbeddedResource preserves text regardless of mimeType', () => {
    const block = assertValidMcpBlock({
      type: 'resource',
      resource: { uri: 'file:///x.json', mimeType: 'application/json', text: '{"a":1}' },
    });
    expect(convertMCPContentBlock(block)).toEqual({ type: 'text', text: '{"a":1}' });
  });

  test('converts blob EmbeddedResource with image/* mimeType to ImageURLPart', () => {
    const block = assertValidMcpBlock({
      type: 'resource',
      resource: { uri: 'file:///pic.webp', mimeType: 'image/webp', blob: 'III' },
    });
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:image/webp;base64,III' },
    });
  });

  test('converts blob EmbeddedResource with audio/* mimeType to AudioURLPart', () => {
    const block = assertValidMcpBlock({
      type: 'resource',
      resource: { uri: 'file:///clip.wav', mimeType: 'audio/wav', blob: 'AUD' },
    });
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'audio_url',
      audioUrl: { url: 'data:audio/wav;base64,AUD' },
    });
  });

  test('converts blob EmbeddedResource with video/* mimeType to VideoURLPart', () => {
    const block = assertValidMcpBlock({
      type: 'resource',
      resource: { uri: 'file:///clip.mp4', mimeType: 'video/mp4', blob: 'VID' },
    });
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'video_url',
      videoUrl: { url: 'data:video/mp4;base64,VID' },
    });
  });

  test('returns null for blob EmbeddedResource with unsupported mimeType', () => {
    const block = assertValidMcpBlock({
      type: 'resource',
      resource: { uri: 'file:///doc.pdf', mimeType: 'application/pdf', blob: 'XXX' },
    });
    expect(convertMCPContentBlock(block)).toBeNull();
  });

  test('blob EmbeddedResource defaults to application/octet-stream and returns null', () => {
    const block = assertValidMcpBlock({
      type: 'resource',
      resource: { uri: 'file:///unknown', blob: 'XXX' },
    });
    expect(convertMCPContentBlock(block)).toBeNull();
  });

  test('returns null for resource block missing resource field', () => {
    // Spec-illegal shape — guards the runtime branch, so skip schema validation.
    const block = { type: 'resource' } as MCPContentBlock;
    expect(convertMCPContentBlock(block)).toBeNull();
  });

  test('converts resource_link with image/* mimeType to ImageURLPart with URL', () => {
    const block = assertValidMcpBlock({
      type: 'resource_link',
      name: 'img.png',
      uri: 'https://example.com/img.png',
      mimeType: 'image/png',
    });
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'image_url',
      imageUrl: { url: 'https://example.com/img.png' },
    });
  });

  test('converts resource_link with audio/* mimeType to AudioURLPart with URL', () => {
    const block = assertValidMcpBlock({
      type: 'resource_link',
      name: 'audio.mp3',
      uri: 'https://example.com/audio.mp3',
      mimeType: 'audio/mpeg',
    });
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'audio_url',
      audioUrl: { url: 'https://example.com/audio.mp3' },
    });
  });

  test('converts resource_link with video/* mimeType to VideoURLPart with URL', () => {
    const block = assertValidMcpBlock({
      type: 'resource_link',
      name: 'video.mp4',
      uri: 'https://example.com/video.mp4',
      mimeType: 'video/mp4',
    });
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'video_url',
      videoUrl: { url: 'https://example.com/video.mp4' },
    });
  });

  test('replaces resource_link with an unsupported image mimeType with a notice', () => {
    // A signed/extensionless URL gives the extension gate nothing to work
    // with; the declared MIME is the only signal — an honestly-declared
    // unsupported format must not become an image_url.
    const block = assertValidMcpBlock({
      type: 'resource_link',
      name: 'photo',
      uri: 'https://cdn.example.com/v2/image?id=123',
      mimeType: 'image/avif',
    });
    const part = convertMCPContentBlock(block);
    if (part?.type !== 'text') throw new Error('expected a text notice');
    expect(part.text).toContain('image/avif');
    expect(part.text).toContain('https://cdn.example.com/v2/image?id=123');
  });

  test('returns null for resource_link with unsupported mimeType', () => {
    const block = assertValidMcpBlock({
      type: 'resource_link',
      name: 'file.bin',
      uri: 'https://example.com/file.bin',
      mimeType: 'application/octet-stream',
    });
    expect(convertMCPContentBlock(block)).toBeNull();
  });

  test('returns null for unknown block type', () => {
    const block: MCPContentBlock = { type: 'fancy_new_type', text: 'whatever' };
    expect(convertMCPContentBlock(block)).toBeNull();
  });

  test('returns null for text block missing text field', () => {
    const block: MCPContentBlock = { type: 'text' };
    expect(convertMCPContentBlock(block)).toBeNull();
  });

  test('returns null for image block missing data field', () => {
    const block: MCPContentBlock = { type: 'image', mimeType: 'image/png' };
    expect(convertMCPContentBlock(block)).toBeNull();
  });
});

describe('mcpResultToExecutableOutput', () => {
  function result(content: MCPContentBlock[], isError = false): MCPToolResult {
    return { content, isError };
  }

  test('emits image_compress telemetry tagged mcp_tool_result', async () => {
    const events: { event: string; props: Record<string, unknown> }[] = [];
    const telemetry: TelemetryClient = {
      track: (event, props) => events.push({ event, props: props ?? {} }),
    };
    const big = Buffer.from(
      await new Jimp({ width: 3600, height: 1800, color: 0x3366ccff }).getBuffer('image/png'),
    ).toString('base64');

    await mcpResultToExecutableOutput(
      result([{ type: 'image', data: big, mimeType: 'image/png' }]),
      'mcp__s__shot',
      { telemetry },
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('image_compress');
    expect(events[0]!.props['source']).toBe('mcp_tool_result');
    expect(events[0]!.props['outcome']).toBe('compressed');
  });

  test('collapses a single text part into a plain string', async () => {
    const out = await mcpResultToExecutableOutput(
      result([{ type: 'text', text: 'hello' }]),
      'mcp__s__t',
    );
    expect(out).toEqual({ output: 'hello', isError: false });
  });

  test('propagates isError=true on the success-shape return', async () => {
    const out = await mcpResultToExecutableOutput(
      result([{ type: 'text', text: 'oops' }], true),
      'mcp__s__t',
    );
    expect(out).toEqual({ output: 'oops', isError: true });
  });

  test('returns an empty string when the content array is empty', async () => {
    const out = await mcpResultToExecutableOutput(result([]), 'mcp__s__t');
    // No parts survive; collapseSingleText has nothing to collapse so the
    // ContentPart[] branch wins. An empty array is the model-visible signal
    // that the tool returned no content.
    expect(out).toEqual({ output: [], isError: false });
  });

  test('drops unconvertible blocks and keeps the rest', async () => {
    const out = await mcpResultToExecutableOutput(
      result([
        { type: 'text', text: 'kept' },
        { type: 'fancy_new_type', text: 'dropped' },
      ]),
      'mcp__s__t',
    );
    expect(out).toEqual({ output: 'kept', isError: false });
  });

  test('wraps media-only output in mcp_tool_result tags using the qualified name', async () => {
    const out = await mcpResultToExecutableOutput(
      result([{ type: 'image', data: 'AAA', mimeType: 'image/png' }]),
      'mcp__github__create_pr',
    );
    expect(out.isError).toBe(false);
    expect(out.output).toEqual([
      { type: 'text', text: '<mcp_tool_result name="mcp__github__create_pr">' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAA' } },
      { type: 'text', text: '</mcp_tool_result>' },
    ]);
  });

  test('replaces an image the provider cannot accept with a text notice (media-only)', async () => {
    // An image search tool returning AVIF: forwarding the image_url would
    // make every later request in the session fail. The media-only wrap is
    // kept, with a notice standing in for the dropped image.
    const out = await mcpResultToExecutableOutput(
      result([{ type: 'image', data: 'QUJD', mimeType: 'image/avif' }]),
      'mcp__search__image',
    );
    expect(out.isError).toBe(false);
    const parts = out.output as ContentPart[];
    expect(parts[0]).toEqual({ type: 'text', text: '<mcp_tool_result name="mcp__search__image">' });
    expect(parts.some((p) => p.type === 'image_url')).toBe(false);
    const notice = parts.find(
      (p) => p.type === 'text' && p.text.includes('image/avif'),
    );
    expect(notice).toBeDefined();
    expect(parts.at(-1)).toEqual({ type: 'text', text: '</mcp_tool_result>' });
  });

  test('drops an unsupported image but keeps the accompanying text', async () => {
    const out = await mcpResultToExecutableOutput(
      result([
        { type: 'text', text: 'found an image' },
        { type: 'image', data: 'QUJD', mimeType: 'image/heic' },
      ]),
      'mcp__search__image',
    );
    const parts = out.output as ContentPart[];
    expect(parts.some((p) => p.type === 'image_url')).toBe(false);
    expect(parts[0]).toEqual({ type: 'text', text: 'found an image' });
    expect(parts.some((p) => p.type === 'text' && p.text.includes('image/heic'))).toBe(true);
  });

  test('gates a mislabeled image on its real bytes (image search tool)', async () => {
    // An image search tool returning AVIF bytes labeled image/png: the
    // bytes are authoritative — the image must not reach the session
    // history, and the notice names the real format.
    const avif = Buffer.alloc(16);
    avif.writeUInt32BE(16, 0);
    avif.write('ftyp', 4, 'latin1');
    avif.write('avif', 8, 'latin1');
    const out = await mcpResultToExecutableOutput(
      result([{ type: 'image', data: avif.toString('base64'), mimeType: 'image/png' }]),
      'mcp__search__image',
    );
    const parts = out.output as ContentPart[];
    expect(parts.some((p) => p.type === 'image_url')).toBe(false);
    expect(parts.some((p) => p.type === 'text' && p.text.includes('image/avif'))).toBe(true);
  });

  test('forwards the image/jpg alias as canonical image/jpeg', async () => {
    // Strict provider whitelists reject the raw `image/jpg` alias — the part
    // must land in the session with the canonical MIME.
    const out = await mcpResultToExecutableOutput(
      result([{ type: 'image', data: 'QUJD', mimeType: 'image/jpg' }]),
      'mcp__s__t',
    );
    const parts = out.output as ContentPart[];
    const image = parts.find((p) => p.type === 'image_url');
    expect(image).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:image/jpeg;base64,QUJD' },
    });
  });

  test('drops remote images by declared MIME and by URL extension, passes accepted links through', async () => {
    // An MCP resource_link carries no bytes, so the only format signals are
    // the declared MIME and the URL extension: an honestly-declared AVIF
    // becomes a notice even with an extensionless (signed) URL — the
    // extension gate alone cannot see it; a server that declares PNG but
    // links an `.avif` URL is caught by the extension; an accepted link
    // passes through.
    const out = await mcpResultToExecutableOutput(
      result([
        assertValidMcpBlock({
          type: 'resource_link',
          name: 'photo',
          uri: 'https://cdn.example.com/v2/image?id=123',
          mimeType: 'image/avif',
        }),
        assertValidMcpBlock({
          type: 'resource_link',
          name: 'pic.avif',
          uri: 'https://example.com/pic.avif',
          mimeType: 'image/png',
        }),
        assertValidMcpBlock({
          type: 'resource_link',
          name: 'ok.png',
          uri: 'https://example.com/ok.png?size=full#frame',
          mimeType: 'image/png',
        }),
      ]),
      'mcp__s__t',
    );
    const parts = out.output as ContentPart[];
    expect(parts).toContainEqual({
      type: 'image_url',
      imageUrl: { url: 'https://example.com/ok.png?size=full#frame' },
    });
    // Neither AVIF link survives as an image_url.
    expect(
      parts.some(
        (p) =>
          p.type === 'image_url' &&
          (p.imageUrl.url.includes('cdn.example.com') || p.imageUrl.url.includes('pic.avif')),
      ),
    ).toBe(false);
    const notices = parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('\n');
    expect(notices).toContain('image/avif');
    // Both notices keep their URL so the model can fetch and convert.
    expect(notices).toContain('https://cdn.example.com/v2/image?id=123');
    expect(notices).toContain('https://example.com/pic.avif');
  });

  test('does NOT wrap when a non-empty text part accompanies the media', async () => {
    const out = await mcpResultToExecutableOutput(
      result([
        { type: 'text', text: 'caption' },
        { type: 'image', data: 'AAA', mimeType: 'image/png' },
      ]),
      'mcp__s__t',
    );
    expect(out.output).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAA' } },
    ]);
  });

  test('an empty-text companion still triggers the wrap', async () => {
    const out = await mcpResultToExecutableOutput(
      result([
        { type: 'text', text: '' },
        { type: 'image', data: 'AAA', mimeType: 'image/png' },
      ]),
      'mcp__s__t',
    );
    const parts = out.output as ContentPart[];
    expect(parts[0]).toEqual({ type: 'text', text: '<mcp_tool_result name="mcp__s__t">' });
    expect(parts.at(-1)).toEqual({ type: 'text', text: '</mcp_tool_result>' });
  });

  test('truncates oversized text and merges the notice into the surviving text part', async () => {
    const out = await mcpResultToExecutableOutput(
      result([{ type: 'text', text: 'x'.repeat(100_001) }]),
      'mcp__s__t',
    );
    // The notice merges into the single text part so collapseSingleText still
    // emits a plain string — the very common "single oversized text" case.
    expect(out.output).toBe('x'.repeat(100_000) + MCP_OUTPUT_TRUNCATED_TEXT);
    expect(out.truncated).toBe(true);
  });

  test('drops oversized binary parts in favor of a per-part notice without touching the text budget', async () => {
    // 14 MiB base64 ≈ 10.5 MiB raw — just above the 10 MiB per-part cap. The
    // bytes are not a real image, so compression fails over and the drop path
    // still applies.
    const huge = 'x'.repeat(14 * 1024 * 1024);
    const out = await mcpResultToExecutableOutput(
      result([{ type: 'image', data: huge, mimeType: 'image/png' }]),
      'mcp__s__big',
    );
    const parts = out.output as ContentPart[];
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: '<mcp_tool_result name="mcp__s__big">' });
    expect(parts[1]?.type).toBe('text');
    expect((parts[1] as { text: string }).text).toContain('image_url dropped');
    expect((parts[1] as { text: string }).text).toContain('10 MB per-part limit');
    expect(parts[2]).toEqual({ type: 'text', text: '</mcp_tool_result>' });
    // The text-budget marker must NOT appear — only the binary part was dropped.
    const joined = parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(joined).not.toContain('Output truncated');
    expect(out.truncated).toBe(true);
  });

  test('binary part within the per-part cap survives intact alongside oversized text', async () => {
    const out = await mcpResultToExecutableOutput(
      result([
        { type: 'text', text: 'A'.repeat(100_000) },
        { type: 'image', data: 'B'.repeat(500_000), mimeType: 'image/png' },
      ]),
      'mcp__s__t',
    );
    // Text fills the entire budget; image still rides through; no truncation
    // marker (text was exactly 100K, not over).
    expect(out.output).toEqual([
      { type: 'text', text: 'A'.repeat(100_000) },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,' + 'B'.repeat(500_000) } },
    ]);
    expect(out.truncated).toBeUndefined();
  });

  test('downsamples an oversized real image instead of leaving it full-size', async () => {
    const big = Buffer.from(
      await new Jimp({ width: 3600, height: 1800, color: 0x3366ccff }).getBuffer('image/png'),
    ).toString('base64');

    const out = await mcpResultToExecutableOutput(
      result([{ type: 'image', data: big, mimeType: 'image/png' }]),
      'mcp__s__shot',
    );

    const parts = out.output as ContentPart[];
    const imagePart = parts.find((p) => p.type === 'image_url');
    expect(imagePart).toBeDefined();
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(
      (imagePart as { imageUrl: { url: string } }).imageUrl.url,
    );
    expect(match).not.toBeNull();
    const dims = sniffImageDimensions(Buffer.from(match![2]!, 'base64'));
    expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(3000);
    // The image was compressed and kept, not dropped to a notice.
    const joined = parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(joined).not.toContain('image_url dropped');
  });

  test('annotates a downsampled image with a caption note and a readable original', async () => {
    const bigBytes = Buffer.from(
      await new Jimp({ width: 3600, height: 1800, color: 0x3366ccff }).getBuffer('image/png'),
    );

    const out = await mcpResultToExecutableOutput(
      result([{ type: 'image', data: bigBytes.toString('base64'), mimeType: 'image/png' }]),
      'mcp__s__shot',
    );

    // The caption rides the `note` side channel (model-only), keeping its
    // `<system>` wrapping; the output itself carries only the media.
    expect(out.note).toContain('Image compressed');
    expect(out.note).toContain('3600x1800');
    const parts = out.output as ContentPart[];
    expect(parts.some((p) => p.type === 'text' && p.text.includes('Image compressed'))).toBe(
      false,
    );
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);

    // The caption points at a persisted copy of the ORIGINAL bytes, so the
    // model can read fine detail back with ReadMediaFile + region.
    const pathMatch = /saved at "([^"]+)"/.exec(out.note ?? '');
    expect(pathMatch).not.toBeNull();
    const persisted = await readFile(pathMatch![1]!);
    expect(persisted.equals(bigBytes)).toBe(true);
    await unlink(pathMatch![1]!).catch(() => undefined);
  });

  test('adds no caption for an image that passes through unchanged', async () => {
    const small = Buffer.from(
      await new Jimp({ width: 32, height: 32, color: 0x3366ccff }).getBuffer('image/png'),
    ).toString('base64');

    const out = await mcpResultToExecutableOutput(
      result([{ type: 'image', data: small, mimeType: 'image/png' }]),
      'mcp__s__shot',
    );

    expect(out.note).toBeUndefined();
    const parts = out.output as ContentPart[];
    const joined = parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(joined).not.toContain('Image compressed');
  });

  test('persists originals into the provided session originals dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-originals-'));
    const bigBytes = Buffer.from(
      await new Jimp({ width: 3600, height: 1800, color: 0x3366ccff }).getBuffer('image/png'),
    );

    const out = await mcpResultToExecutableOutput(
      result([{ type: 'image', data: bigBytes.toString('base64'), mimeType: 'image/png' }]),
      'mcp__s__shot',
      { originalsDir: dir },
    );

    const pathMatch = /saved at "([^"]+)"/.exec(out.note ?? '');
    expect(pathMatch).not.toBeNull();
    // The original lands inside the session-scoped dir, not the tmp cache.
    expect(pathMatch![1]!.startsWith(dir)).toBe(true);
    const persisted = await readFile(pathMatch![1]!);
    expect(persisted.equals(bigBytes)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test('keeps the caption intact when the tool text exhausts the 100K budget', async () => {
    // The caption must never compete with the tool's own text for the budget:
    // a chatty tool (page text + screenshot) would otherwise silently evict
    // it, reintroducing exactly the silent downsampling the caption exists
    // to prevent — and orphaning the persisted original.
    const dir = await mkdtemp(join(tmpdir(), 'mcp-originals-'));
    const big = Buffer.from(
      await new Jimp({ width: 3600, height: 1800, color: 0x3366ccff }).getBuffer('image/png'),
    ).toString('base64');

    const out = await mcpResultToExecutableOutput(
      result([
        { type: 'text', text: 'x'.repeat(100_001) },
        { type: 'image', data: big, mimeType: 'image/png' },
      ]),
      'mcp__s__shot',
      { originalsDir: dir },
    );

    const parts = out.output as ContentPart[];
    // The tool text is truncated (with the notice), the image survives…
    expect(out.truncated).toBe(true);
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
    const toolText = parts[0];
    if (toolText?.type !== 'text') throw new Error('expected the tool text part first');
    expect(toolText.text).toContain('Output truncated');
    // …and the caption survives INTACT in the note, still pointing at the
    // original — the note channel is exempt from the text budget by
    // construction.
    expect(out.note).toMatch(/<\/system>$/);
    expect(out.note).toContain('saved at');
    await rm(dir, { recursive: true, force: true });
  });

  test('keeps MCP text that quotes a compression caption in the output', async () => {
    // Captions reach the note as structured data straight from the
    // compressor — never by pattern-matching text — so tool output that
    // merely QUOTES a caption (a doc, a log, a test fixture) stays verbatim.
    const quoted =
      '<system>Image compressed to fit model limits: original 100x100 image/png (1.0 MB) -> ' +
      'sent 50x50 image/jpeg (100 KB). Fine detail may be lost. ' +
      'The uncompressed original was not preserved.</system>';
    const small = Buffer.from(
      await new Jimp({ width: 32, height: 32, color: 0x3366ccff }).getBuffer('image/png'),
    ).toString('base64');

    const out = await mcpResultToExecutableOutput(
      result([
        { type: 'text', text: `doc quoting a caption: ${quoted}` },
        { type: 'image', data: small, mimeType: 'image/png' },
      ]),
      'mcp__s__t',
    );

    expect(out.note).toBeUndefined();
    const parts = out.output as ContentPart[];
    const joined = parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(joined).toContain(quoted);
  });

  test('separates a real compression caption from quoted caption text', async () => {
    const quoted =
      '<system>Image compressed to fit model limits: original 100x100 image/png (1.0 MB) -> ' +
      'sent 50x50 image/jpeg (100 KB). Fine detail may be lost. ' +
      'The uncompressed original was not preserved.</system>';
    const big = Buffer.from(
      await new Jimp({ width: 3600, height: 1800, color: 0x3366ccff }).getBuffer('image/png'),
    ).toString('base64');

    const out = await mcpResultToExecutableOutput(
      result([
        { type: 'text', text: quoted },
        { type: 'image', data: big, mimeType: 'image/png' },
      ]),
      'mcp__s__t',
    );

    // The real caption (3600x1800) rides the note; the quoted one (100x100)
    // is tool output and stays where the tool put it.
    expect(out.note).toContain('3600x1800');
    expect(out.note).not.toContain('100x100');
    const parts = out.output as ContentPart[];
    const joined = parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(joined).toContain('100x100');
  });

  test('does not slice the caption when the budget is nearly exhausted', async () => {
    // 99,900 chars of tool text fit the budget on their own; the caption
    // must not be charged the remaining 100 chars and sliced mid-string
    // into an unclosed <system> fragment.
    const dir = await mkdtemp(join(tmpdir(), 'mcp-originals-'));
    const big = Buffer.from(
      await new Jimp({ width: 3600, height: 1800, color: 0x3366ccff }).getBuffer('image/png'),
    ).toString('base64');

    const out = await mcpResultToExecutableOutput(
      result([
        { type: 'text', text: 'y'.repeat(99_900) },
        { type: 'image', data: big, mimeType: 'image/png' },
      ]),
      'mcp__s__shot',
      { originalsDir: dir },
    );

    const parts = out.output as ContentPart[];
    // The tool text fits — nothing is truncated at all.
    expect(out.truncated).toBeUndefined();
    expect(out.note).toMatch(/^<system>Image compressed/);
    expect(out.note).toMatch(/<\/system>$/);
    expect(out.note).toContain('saved at');
    const joined = parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(joined).not.toContain('Output truncated');
    await rm(dir, { recursive: true, force: true });
  });
});
