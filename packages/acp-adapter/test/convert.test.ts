import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContentBlock } from '@agentclientprotocol/sdk';
import { Jimp } from 'jimp';

import { log, type ToolInputDisplay } from '@moonshot-ai/kimi-code-sdk';

import {
  acpBlocksToPromptParts,
  compressPromptImageParts,
  displayBlockToAcpContent,
} from '../src/convert';

const textBlock = (text: string): ContentBlock => ({ type: 'text', text });
const imageBlock = (data: string, mimeType: string): ContentBlock => ({
  type: 'image',
  data,
  mimeType,
});
const audioBlock = (data: string, mimeType: string): ContentBlock => ({
  type: 'audio',
  data,
  mimeType,
});
const resourceLinkBlock = (uri: string, name: string): ContentBlock => ({
  type: 'resource_link',
  uri,
  name,
});
const textResourceBlock = (uri: string, text: string, mimeType?: string): ContentBlock => ({
  type: 'resource',
  resource: mimeType !== undefined ? { uri, text, mimeType } : { uri, text },
});
const blobResourceBlock = (uri: string, blob: string, mimeType?: string): ContentBlock => ({
  type: 'resource',
  resource: mimeType !== undefined ? { uri, blob, mimeType } : { uri, blob },
});

describe('acpBlocksToPromptParts', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns an empty array for an empty input', () => {
    expect(acpBlocksToPromptParts([])).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('passes text blocks through as { type: text, text }', () => {
    const out = acpBlocksToPromptParts([textBlock('hello'), textBlock('world')]);
    expect(out).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('lifts image blocks into image_url parts with a data URL', () => {
    const out = acpBlocksToPromptParts([
      textBlock('caption'),
      imageBlock('iVBORw0KGgoAAAA', 'image/png'),
    ]);
    expect(out).toEqual([
      { type: 'text', text: 'caption' },
      {
        type: 'image_url',
        imageUrl: { url: 'data:image/png;base64,iVBORw0KGgoAAAA' },
      },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits image and text parts in input order', () => {
    const out = acpBlocksToPromptParts([
      imageBlock('AAAA', 'image/jpeg'),
      textBlock('what is this?'),
    ]);
    expect(out).toEqual([
      {
        type: 'image_url',
        imageUrl: { url: 'data:image/jpeg;base64,AAAA' },
      },
      { type: 'text', text: 'what is this?' },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('treats raw base64 as opaque — does not strip data: prefixes (documented limitation)', () => {
    // Defensive behavior: a caller that pre-wraps the payload as a data URL
    // will end up double-wrapped. The ACP spec says `data` is base64, so this
    // only affects non-conforming callers.
    const out = acpBlocksToPromptParts([
      imageBlock('data:image/png;base64,XXXX', 'image/png'),
    ]);
    expect(out).toEqual([
      {
        type: 'image_url',
        imageUrl: { url: 'data:image/png;base64,data:image/png;base64,XXXX' },
      },
    ]);
  });

  it('drops audio blocks but warns with the dedicated message', () => {
    const out = acpBlocksToPromptParts([
      textBlock('hi'),
      audioBlock('AAAA', 'audio/mpeg'),
    ]);
    expect(out).toEqual([{ type: 'text', text: 'hi' }]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping unsupported audio prompt block'),
      expect.objectContaining({ mimeType: 'audio/mpeg' }),
    );
  });

  it('projects file:// resource_link blocks to bare paths', () => {
    const out = acpBlocksToPromptParts([
      resourceLinkBlock('file:///a.txt', 'a'),
      textBlock('see linked file'),
      resourceLinkBlock('file:///b.txt', 'b'),
    ]);
    expect(out).toEqual([
      { type: 'text', text: '/a.txt' },
      { type: 'text', text: 'see linked file' },
      { type: 'text', text: '/b.txt' },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('appends a line range to file:// paths when the fragment carries one', () => {
    const out = acpBlocksToPromptParts([
      resourceLinkBlock('file:///src/foo.ts#L10', 'foo.ts'),
      resourceLinkBlock('file:///src/foo.ts#L10-L20', 'foo.ts'),
      resourceLinkBlock('file:///src/foo.ts#L10-20', 'foo.ts'),
      resourceLinkBlock('file:///src/foo.ts?line=10', 'foo.ts'),
      resourceLinkBlock('file:///src/foo.ts?lines=10-20', 'foo.ts'),
    ]);
    expect(out.map((p) => (p.type === 'text' ? p.text : ''))).toEqual([
      '/src/foo.ts:10',
      '/src/foo.ts:10-20',
      '/src/foo.ts:10-20',
      '/src/foo.ts:10',
      '/src/foo.ts:10-20',
    ]);
  });

  it('URL-decodes file:// paths (spaces, unicode)', () => {
    const out = acpBlocksToPromptParts([
      resourceLinkBlock('file:///Users/a%20b/foo.ts', 'foo.ts'),
      resourceLinkBlock('file:///Users/%E4%B8%AD%E6%96%87/foo.ts', 'foo.ts'),
    ]);
    expect(out).toEqual([
      { type: 'text', text: '/Users/a b/foo.ts' },
      { type: 'text', text: '/Users/中文/foo.ts' },
    ]);
  });

  it('strips the leading slash on Windows file:// drive paths', () => {
    const out = acpBlocksToPromptParts([
      resourceLinkBlock('file:///C:/Users/x/foo.ts', 'foo.ts'),
      resourceLinkBlock('file:///D:/work/bar.ts#L42', 'bar.ts'),
    ]);
    expect(out).toEqual([
      { type: 'text', text: 'C:/Users/x/foo.ts' },
      { type: 'text', text: 'D:/work/bar.ts:42' },
    ]);
  });

  it('preserves non-local file:// hosts as UNC paths', () => {
    const out = acpBlocksToPromptParts([
      resourceLinkBlock('file://server/share/project/a.ts#L3', 'a.ts'),
      resourceLinkBlock('file://server/share/project/b.ts?lines=10-20', 'b.ts'),
      resourceLinkBlock('file://localhost/share/project/c.ts#L3', 'c.ts'),
    ]);
    expect(out).toEqual([
      { type: 'text', text: '//server/share/project/a.ts:3' },
      { type: 'text', text: '//server/share/project/b.ts:10-20' },
      { type: 'text', text: '/share/project/c.ts:3' },
    ]);
  });

  it('lowercases UNC hosts so case-variant inputs collapse to one ref', () => {
    const out = acpBlocksToPromptParts([
      resourceLinkBlock('file://SERVER/share/project/a.ts#L3', 'a.ts'),
      resourceLinkBlock('file://Server/share/project/a.ts#L3', 'a.ts'),
      resourceLinkBlock('file://LOCALHOST/share/project/c.ts#L3', 'c.ts'),
    ]);
    expect(out).toEqual([
      { type: 'text', text: '//server/share/project/a.ts:3' },
      { type: 'text', text: '//server/share/project/a.ts:3' },
      { type: 'text', text: '/share/project/c.ts:3' },
    ]);
  });

  it('keeps the XML wrapper for non-file:// resource_link schemes', () => {
    const out = acpBlocksToPromptParts([
      resourceLinkBlock('zed:///agent/terminal-selection?lines=10', 'Terminal (10 lines)'),
      resourceLinkBlock('https://example.com/spec', 'spec'),
    ]);
    expect(out).toEqual([
      {
        type: 'text',
        text:
          '<resource_link uri="zed:///agent/terminal-selection?lines=10" name="Terminal (10 lines)" />',
      },
      {
        type: 'text',
        text: '<resource_link uri="https://example.com/spec" name="spec" />',
      },
    ]);
  });

  it('falls back to the XML wrapper for unparseable resource_link uris', () => {
    const out = acpBlocksToPromptParts([resourceLinkBlock('not a url', 'weird')]);
    expect(out).toEqual([
      { type: 'text', text: '<resource_link uri="not a url" name="weird" />' },
    ]);
  });

  it('inlines TextResourceContents as <resource uri>text</resource>', () => {
    const out = acpBlocksToPromptParts([
      textResourceBlock('file:///hello.md', '# Hello\nworld', 'text/markdown'),
    ]);
    expect(out).toEqual([
      {
        type: 'text',
        text: '<resource uri="file:///hello.md"># Hello\nworld</resource>',
      },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('drops BlobResourceContents with a dedicated warn', () => {
    const out = acpBlocksToPromptParts([
      blobResourceBlock('file:///pic.bin', 'AAAA', 'application/octet-stream'),
    ]);
    expect(out).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping blob embedded resource'),
      expect.objectContaining({
        uri: 'file:///pic.bin',
        mimeType: 'application/octet-stream',
      }),
    );
  });

  it('escapes XML-special characters in non-file:// resource_link attributes', () => {
    const out = acpBlocksToPromptParts([
      resourceLinkBlock('https://example.com/a&b', 'name with "quotes" & <angle>'),
    ]);
    expect(out).toEqual([
      {
        type: 'text',
        text:
          '<resource_link uri="https://example.com/a&amp;b" name="name with &quot;quotes&quot; &amp; &lt;angle&gt;" />',
      },
    ]);
  });

  it('emits mixed text + resource_link + embedded text resource in input order', () => {
    const out = acpBlocksToPromptParts([
      textBlock('header'),
      resourceLinkBlock('file:///x', 'x'),
      textResourceBlock('file:///y.txt', 'body'),
    ]);
    expect(out).toEqual([
      { type: 'text', text: 'header' },
      { type: 'text', text: '/x' },
      { type: 'text', text: '<resource uri="file:///y.txt">body</resource>' },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('displayBlockToAcpContent — plan_review branch (Phase 13.2)', () => {
  const planMd = '## Goal\n\nShip the plan_review surface so Zed sees the markdown body.';

  it('returns null when block.plan is empty after trimming', () => {
    const block: ToolInputDisplay = { kind: 'plan_review', plan: '   \n\t  ' };
    expect(displayBlockToAcpContent(block)).toBeNull();
  });

  it('renders the plan markdown alone when no path is set', () => {
    const block: ToolInputDisplay = { kind: 'plan_review', plan: planMd };
    expect(displayBlockToAcpContent(block)).toEqual({
      type: 'content',
      content: { type: 'text', text: planMd },
    });
  });

  it('prefixes "Plan saved to: <path>" when block.path is set', () => {
    const block: ToolInputDisplay = {
      kind: 'plan_review',
      plan: planMd,
      path: '/tmp/plan.md',
    };
    expect(displayBlockToAcpContent(block)).toEqual({
      type: 'content',
      content: {
        type: 'text',
        text: `Plan saved to: /tmp/plan.md\n\n${planMd}`,
      },
    });
  });

  it('preserves the plan body verbatim — no markdown escaping or normalisation', () => {
    const richMd = '**bold** & <tag> with "quotes"';
    const block: ToolInputDisplay = { kind: 'plan_review', plan: richMd };
    const out = displayBlockToAcpContent(block);
    expect(out).toEqual({
      type: 'content',
      content: { type: 'text', text: richMd },
    });
  });

  it('still returns null for an unmapped kind (Phase 5 invariant)', () => {
    const cmd: ToolInputDisplay = { kind: 'command', command: 'ls' };
    expect(displayBlockToAcpContent(cmd)).toBeNull();
  });
});

describe('compressPromptImageParts', () => {
  async function pngBase64(width: number, height: number): Promise<string> {
    const buf = await new Jimp({ width, height, color: 0x3366ccff }).getBuffer('image/png');
    return Buffer.from(buf).toString('base64');
  }

  it('downsamples an oversized inline image part', async () => {
    const parts = acpBlocksToPromptParts([imageBlock(await pngBase64(2600, 2600), 'image/png')]);
    const compressed = await compressPromptImageParts(parts);

    const part = compressed[0];
    if (part?.type !== 'image_url') throw new Error('expected an image_url part');
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(part.imageUrl.url);
    expect(match).not.toBeNull();
    const decoded = await Jimp.fromBuffer(Buffer.from(match![2]!, 'base64'));
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(2000);
  });

  it('passes a within-budget image and text through unchanged', async () => {
    const parts = acpBlocksToPromptParts([
      imageBlock(await pngBase64(32, 32), 'image/png'),
      textBlock('hi'),
    ]);
    const compressed = await compressPromptImageParts(parts);
    expect(compressed).toEqual(parts);
  });
});
