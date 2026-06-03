import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContentBlock } from '@agentclientprotocol/sdk';

import { log, type ToolInputDisplay } from '@moonshot-ai/kimi-code-sdk';

import { acpBlocksToPromptParts, displayBlockToAcpContent } from '../src/convert';

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

  it('inlines resource_link blocks as <resource_link uri name /> text', () => {
    const out = acpBlocksToPromptParts([
      resourceLinkBlock('file:///a.txt', 'a'),
      textBlock('see linked file'),
      resourceLinkBlock('file:///b.txt', 'b'),
    ]);
    expect(out).toEqual([
      { type: 'text', text: '<resource_link uri="file:///a.txt" name="a" />' },
      { type: 'text', text: 'see linked file' },
      { type: 'text', text: '<resource_link uri="file:///b.txt" name="b" />' },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('escapes XML-special characters in resource_link attributes', () => {
    const out = acpBlocksToPromptParts([
      resourceLinkBlock('file:///a&b.txt', 'name with "quotes" & <angle>'),
    ]);
    expect(out).toEqual([
      {
        type: 'text',
        text:
          '<resource_link uri="file:///a&amp;b.txt" name="name with &quot;quotes&quot; &amp; &lt;angle&gt;" />',
      },
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

  it('emits mixed text + resource_link + embedded text resource in input order', () => {
    const out = acpBlocksToPromptParts([
      textBlock('header'),
      resourceLinkBlock('file:///x', 'x'),
      textResourceBlock('file:///y.txt', 'body'),
    ]);
    expect(out).toEqual([
      { type: 'text', text: 'header' },
      { type: 'text', text: '<resource_link uri="file:///x" name="x" />' },
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
