import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { EditorState } from 'prosemirror-state';
import type { BrowserCapture } from '@moonshot-ai/app-core/browser-reference';
import { composerSchema } from '../../src/model/schema';
import { textToDoc } from '../../src/model/documentCodec';
import type { ComposerDocumentSnapshot } from '../../src/model/snapshot';
import { copyComposerSlice, copyComposerSnapshot, renderedComposerSlice } from '../../src/transcript/selectionClipboard';
import { buildAttachmentClipboardPaste, parseComposerClipboardPayload } from '../../src/features/attachment/clipboard';
import { browserReferenceInventory } from '../../src/features/browser-reference/inventory';
import { composerPlugins } from '../../src/runtime/plugins';

const capture: BrowserCapture = {
  version: 1, id: 'bc_example', ordinal: 1, label: '按钮：保存', capturedAt: '2026-09-07T00:00:00.000Z',
  page: { url: 'https://example.test/settings', title: 'Settings' },
  target: { kind: 'element', tagName: 'button', accessibleName: '保存', bounds: { x: 10, y: 10, width: 100, height: 30 } },
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, zoomFactor: 1, devicePixelRatio: 2 },
  screenshot: { attachmentId: 'shot', crop: { x: 10, y: 10, width: 100, height: 30 }, pixelWidth: 200, pixelHeight: 60 },
};

function snapshot(): ComposerDocumentSnapshot {
  return {
    version: 1,
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: '[literal](src/a.ts) ' },
      { type: 'browser_reference', attrs: { refId: 'br_first', label: capture.label } },
      { type: 'text', text: ' then ' },
      { type: 'browser_reference', attrs: { refId: 'br_second', label: capture.label } },
    ] }] },
    attachments: [{ attId: 'shot', key: 'blob:session-a:shot-file', kind: 'image', name: 'capture.png', uploading: false, refCount: 0, fileId: 'shot-file', sessionId: 'session-a', purpose: 'browser-screenshot' }],
    attachmentOrder: ['shot'],
    browserCaptures: [capture],
    browserReferences: [{ id: 'br_first', captureId: capture.id, comment: 'First comment' }, { id: 'br_second', captureId: capture.id, comment: 'Second comment' }],
  };
}

function fragment(html: string): DocumentFragment {
  const { document } = parseHTML('<html><body></body></html>');
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function browserPill(id: string): string {
  return `<span class="quote-pill browser-reference-pill" data-browser-ref-id="${id}" data-browser-ref-label="按钮：保存"><span class="quote-pill-icon"><svg /></span><span class="quote-pill-name">按钮：保…</span><span class="quote-pill-comment">Visual comment</span></span>`;
}

describe('sent message selection clipboard', () => {
  it('copies only selected references with their own comments and shared screenshot evidence', () => {
    const source = snapshot();
    const slice = renderedComposerSlice(fragment(`Selected ${browserPill('br_second')}`), source);
    const copy = copyComposerSlice(slice, source)!;
    expect(copy.plain).toBe('Selected 按钮：保存\nhttps://example.test/settings\nSecond comment');
    const payload = parseComposerClipboardPayload(copy.flavor)!;
    expect(payload.browserReferences).toEqual([source.browserReferences![1]]);
    expect(payload.browserCaptures).toEqual([capture]);
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0]?.fileId).toBe('shot-file');
    const empty = EditorState.create({ schema: composerSchema, doc: textToDoc(''), plugins: composerPlugins() });
    const restored = empty.apply(buildAttachmentClipboardPaste(empty, copy.flavor)!);
    const references = [...browserReferenceInventory(restored).references.values()];
    expect(references).toHaveLength(1);
    expect(references[0]?.id).not.toBe('br_second');
    expect(references[0]?.comment).toBe('Second comment');
  });

  it('keeps an annotated attachment comment when copying a sent message', () => {
    const pill = '<span class="attachment-pill" data-attachment-id="1" data-attachment-kind="image" data-attachment-name="shot.png" data-attachment-comment="Fix this">shot</span>';
    const slice = renderedComposerSlice(fragment(`${pill}<span class="q-sep">\n\n</span>${pill.replace('"1"', '"2"')}`));
    const nodes: Array<{ type: string; comment?: unknown; text?: string }> = [];
    slice.content.descendants((node) => { if (node.isInline) nodes.push({ type: node.type.name, comment: node.attrs['comment'], text: node.text }); });
    expect(nodes).toEqual([
      { type: 'attachment', comment: 'Fix this', text: undefined },
      { type: 'text', comment: undefined, text: ' ' },
      { type: 'attachment', comment: 'Fix this', text: undefined },
    ]);
    expect(copyComposerSlice(slice)!.plain).toBe('shot.png\nFix this shot.png\nFix this');
  });

  it('preserves literal Markdown next to real mention, quote and attachment nodes', () => {
    const slice = renderedComposerSlice(fragment('[literal](src/literal.ts) <span class="mention-pill" data-mention-kind="file" data-mention-name="real.ts" data-mention-path="src/real.ts">truncated</span> <span class="quote-pill" data-quote-text="source text" data-quote-comment="my comment">summary</span> <span class="attachment-pill" data-attachment-id="1" data-attachment-kind="file" data-attachment-name="report.txt">report</span>'));
    const payload = parseComposerClipboardPayload(copyComposerSlice(slice, undefined, [{ kind: 'file', name: 'report.txt', fileId: 'file-report', sessionId: 'session-a', url: '' }])!.flavor)!;
    const nodes = payload.slice.content.firstChild!;
    expect(nodes.child(0).type.name).toBe('text');
    expect(nodes.child(0).text).toBe('[literal](src/literal.ts) ');
    expect(nodes.child(1).attrs).toEqual({ kind: 'file', name: 'real.ts', path: 'src/real.ts' });
    expect(nodes.child(3).attrs).toEqual({ text: 'source text', comment: 'my comment', source: '' });
    expect(nodes.child(5).type.name).toBe('attachment');
    expect(payload.attachments[0]?.fileId).toBe('file-report');
  });

  it('preserves the original line target when copying a file mention', () => {
    const pill = '<span class="mention-pill" data-mention-kind="file" data-mention-name="情况" data-mention-path="docs/情况.md:78" data-mention-raw-dest="docs/情况.md:78">情况</span>';
    const slice = renderedComposerSlice(fragment(pill));
    expect(copyComposerSlice(slice)!.plain).toBe('[情况](docs/情况.md:78)');
  });

  it('preserves snapshot paragraph separators between quotes without adding presentation separators', () => {
    const html = '<span class="quote-pill" data-quote-text="one">one</span><span class="q-sep">\n\n</span><span class="quote-pill" data-quote-text="two">two</span>';
    const typed = renderedComposerSlice(fragment(html), snapshot());
    expect(typed.content.childCount).toBe(3);
    expect(typed.content.child(1).content.size).toBe(0);
    const legacy = renderedComposerSlice(fragment(html));
    expect(legacy.content.childCount).toBe(1);
    expect(legacy.content.firstChild!.child(1).text).toBe(' ');
  });

  it('copies the entire typed snapshot without reparsing text or duplicating shared image resources', () => {
    const source = snapshot();
    const copy = copyComposerSnapshot(source)!;
    const payload = parseComposerClipboardPayload(copy.flavor)!;
    expect(payload.slice.content.firstChild?.firstChild?.type.name).toBe('text');
    expect(payload.browserReferences).toEqual(source.browserReferences);
    expect(payload.browserCaptures).toHaveLength(1);
    expect(payload.attachments).toHaveLength(1);
    expect(copy.plain).toContain('First comment');
    expect(copy.plain).toContain('Second comment');
    expect(copy.plain).not.toContain('kimi-code-composer://');
  });

  it('retains a rich missing reference without binding it to an unrelated capture', () => {
    const copy = copyComposerSlice(renderedComposerSlice(fragment(browserPill('br_missing')), snapshot()), snapshot())!;
    const payload = parseComposerClipboardPayload(copy.flavor)!;
    expect(payload.slice.content.firstChild!.firstChild!.type.name).toBe('browser_reference');
    expect(payload.browserReferences).toEqual([]);
    expect(payload.browserCaptures).toEqual([]);
    expect(payload.attachments).toEqual([]);
    expect(copy.plain).toBe('按钮：保存');
  });
});
