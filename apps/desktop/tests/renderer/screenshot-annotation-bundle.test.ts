// @vitest-environment jsdom
import { createApp, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComposerEditor, runComposerMenuEdit, type ComposerEditorApi } from '@moonshot-ai/app-composer/runtime';
import { ComposerText, startMentionTooltip } from '@moonshot-ai/app-composer/transcript';
import { degradeForeignAttachmentLinks, parseAttachmentLinks, reviveQuoteBlockLinks, rewriteAttachmentLinksForSubmit, serializeAttachment, type AttachmentAttrs } from '@moonshot-ai/app-composer/model';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import { rewriteQuoteLinks } from '@moonshot-ai/app-client/lib';

const attrs: AttachmentAttrs = { attId: 'shot1', name: 'Screenshot.png', kind: 'image' };
const entry: AttachmentEntry = { ...attrs, key: 'blob:shot1', refCount: 0, uploading: false, fileId: 'image1' };
let host: HTMLDivElement;
let editor: ComposerEditorApi;
let app: App | undefined;
let stopTooltip: (() => void) | undefined;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
  editor = createComposerEditor(host, { initialText: '', onChange: () => {}, handleKeyDown: () => false });
});

afterEach(() => {
  stopTooltip?.();
  stopTooltip = undefined;
  app?.unmount();
  app = undefined;
  editor.destroy();
  host.remove();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('screenshot annotation bundle', () => {
  it('inserts one image/comment pill and undoes/redoes it together with the image', () => {
    editor.insertAttachmentWithText(attrs, '看这里', undefined, entry);
    expect(editor.dom.querySelectorAll('.attachment-pill')).toHaveLength(1);
    expect(editor.dom.querySelector('.attachment-pill .quote-pill-comment')?.textContent).toBe('看这里');
    expect(editor.dom.querySelector('p')?.textContent).toBe('Screenshot.png看这里 ');
    expect(editor.getAttachmentInventory().activeIds.has('shot1')).toBe(true);
    expect(runComposerMenuEdit(editor.dom, 'undo')).toBe(true);
    expect(editor.getText()).toBe('');
    expect(editor.getAttachmentInventory().activeIds.has('shot1')).toBe(false);
    expect(runComposerMenuEdit(editor.dom, 'redo')).toBe(true);
    expect(editor.dom.querySelector('.quote-pill-comment')?.textContent).toBe('看这里');
    expect(editor.getAttachmentInventory().activeIds.has('shot1')).toBe(true);
  });

  it('restores comments with drafts and keeps successive screenshots separate', () => {
    editor.insertAttachmentWithText(attrs, '第一处', undefined, entry);
    editor.insertAttachmentWithText({ ...attrs, attId: 'shot2' }, '第二处', undefined, { ...entry, attId: 'shot2', key: 'blob:shot2' });
    const draft = editor.getText();
    const entries = editor.getAttachmentEntries();
    editor.setText('');
    editor.setText(draft, { entries });
    expect([...editor.dom.querySelectorAll('.attachment-pill .quote-pill-comment')].map((node) => node.textContent)).toEqual(['第一处', '第二处']);
    expect(parseAttachmentLinks(editor.getText()).map((link) => link.attrs.comment)).toEqual(['第一处', '第二处']);
    editor.removeAttachmentReferences('shot1');
    expect(editor.dom.querySelectorAll('.attachment-pill')).toHaveLength(1);
    expect(editor.dom.querySelector('.quote-pill-comment')?.textContent).toBe('第二处');
  });

  it('keeps ordinary image references unchanged without a comment', () => {
    editor.insertAttachmentWithText(attrs, '', undefined, entry);
    expect(editor.getText()).toBe(`${serializeAttachment(attrs)} `);
    expect(editor.dom.querySelector('.quote-pill-comment')).toBeNull();
  });

  it('shows the complete comment alongside the image preview on focus', () => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    const comment = '这是一段超过标注块显示宽度的评论，悬浮预览应当显示全部内容';
    editor.insertAttachmentWithText(attrs, comment, undefined, entry);
    stopTooltip = startMentionTooltip({});
    const pill = editor.dom.querySelector('.attachment-pill')!;
    vi.spyOn(pill, 'matches').mockImplementation((selector) => selector === ':focus-visible');
    pill.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(600);
    expect(document.querySelector('.mention-tip-media .mention-tip-media-preview')).not.toBeNull();
    expect(document.querySelector('.mention-tip-media .mention-tip-quote-comment')?.textContent).toBe(comment);
  });

  it('renders the same bundle after submission and keeps comments when copying it', () => {
    const draft = serializeAttachment({ ...attrs, comment: '看这里' });
    const wire = rewriteQuoteLinks(rewriteAttachmentLinksForSubmit(draft, { fileAttIds: [], mediaAttIds: ['shot1'] }));
    expect(wire).toBe('> [Screenshot.png](kimi-code-composer://attachments/m1)\n\n看这里');
    const transcript = document.createElement('div');
    host.append(transcript);
    app = createApp(ComposerText, { text: wire, attachments: [{ kind: 'image', url: '/image1', mediaType: 'image/png', mediaOrdinal: 1 }], mediaLabels: { image: '图片', video: '视频' } });
    app.mount(transcript);
    const pill = transcript.querySelector('.attachment-pill')!;
    expect(pill.querySelector('.quote-pill-comment')?.textContent).toBe('看这里');
    expect(pill.getAttribute('data-attachment-id')).toBe('m1');
    expect(pill.querySelector('.attachment-pill-name')?.textContent).toBe('图片 1');
    expect(pill.getAttribute('data-attachment-url')).toBe('/image1');
    expect(transcript.textContent).not.toContain('kimi-code-composer');
    const range = document.createRange();
    range.selectNode(pill);
    window.getSelection()?.addRange(range);
    const data = new Map<string, string>();
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => data.set(type, value) } });
    transcript.querySelector('.composer-text')!.dispatchEvent(event);
    expect(data.get('text/plain')).toContain('看这里');
    expect(data.has('application/x-kimi-composer')).toBe(true);
    editor.focus();
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: {
      getData: (type: string) => data.get(type) ?? '',
      types: [...data.keys()], files: [], items: [],
    } });
    editor.dom.dispatchEvent(paste);
    expect(editor.dom.querySelector('.attachment-pill .quote-pill-comment')?.textContent).toBe('看这里');
    expect(editor.getAttachmentEntries()[0]?.kind).toBe('image');
    const revived = reviveQuoteBlockLinks(wire);
    expect(parseAttachmentLinks(revived)[0]?.attrs.comment).toBe('看这里');
    expect(degradeForeignAttachmentLinks(draft, new Set())).toBe('Screenshot.png\n看这里');
  });
});
