// @vitest-environment jsdom
import { createApp, h, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HighlightedCode from '../src/HighlightedCode.vue';

vi.mock('@moonshot-ai/app-core', () => ({
  useIsDark: () => ref(false),
}));

vi.mock('@moonshot-ai/app-core/lib', () => ({
  codeLanguageFromPath: () => undefined,
  logWarn: vi.fn(),
}));

vi.mock('@moonshot-ai/app-core/client', () => ({
  splitLines: (text: string) => text.split('\n'),
}));

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  window.getSelection()?.removeAllRanges();
});

interface ClipboardPayload {
  plain: string | null;
  html: string | null;
  defaultPrevented: boolean;
}

function dispatchCopy(target: Element): ClipboardPayload {
  const data = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: {
      setData: (mime: string, value: string) => { data.set(mime, value); },
    },
  });
  target.dispatchEvent(event);
  return {
    plain: data.get('text/plain') ?? null,
    html: data.get('text/html') ?? null,
    defaultPrevented: event.defaultPrevented,
  };
}

function mountPlain(code: string, lineNumbers = [1, 2, 3, 4, 5, 6]): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'fp-body';
  host.append(wrapper);
  app = createApp({ render: () => h(HighlightedCode, { code: code.split('\n'), lineNumbers, framed: false }) });
  app.mount(wrapper);
  return wrapper;
}

describe('HighlightedCode copy serialization', () => {
  it('preserves blank lines and the trailing newline when copying a select-all range without gutters', () => {
    const source = 'export const first = 1;\n\nexport const second = 2;\n\n\nexport const third = 3;\n';
    const wrapper = mountPlain(source, [1, 2, 3, 4, 5, 6, 7]);
    window.getSelection()!.selectAllChildren(wrapper);

    const copied = dispatchCopy(wrapper.querySelector('.hl-text')!);

    expect(copied.defaultPrevented).toBe(true);
    expect(copied.plain).toBe(source);
    expect(copied.html).not.toContain('hl-gutter');
    expect(copied.html).toContain('<br>');
  });

  it('preserves blank lines inside a partial selection across rows', () => {
    const wrapper = mountPlain('alpha\n\n\nbeta\ngamma', [1, 2, 3, 4, 5]);
    const texts = [...wrapper.querySelectorAll('.hl-text')];
    const firstText = [...texts[0]!.childNodes].find(n => (n.nodeValue ?? '').length > 0)!;
    const fourthText = [...texts[3]!.childNodes].find(n => (n.nodeValue ?? '').length > 0)!;
    const range = document.createRange();
    range.setStart(firstText, 2);
    range.setEnd(fourthText, 3);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const copied = dispatchCopy(texts[0]!);

    expect(copied.defaultPrevented).toBe(true);
    expect(copied.plain).toBe('pha\n\n\nbet');
  });

  it('does not add a trailing blank row when the selection ends at column zero of the next row', () => {
    const wrapper = mountPlain('alpha\nbeta\ngamma', [1, 2, 3]);
    const rows = [...wrapper.querySelectorAll('.hl-row')];
    const firstText = [...rows[0]!.querySelector('.hl-text')!.childNodes].find(n => (n.nodeValue ?? '').length > 0)!;
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.setEnd(rows[1]!, 0);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const copied = dispatchCopy(rows[0]!);

    expect(copied.defaultPrevented).toBe(true);
    expect(copied.plain).toBe('alpha');
  });

  it('leaves cross-block selections to the default copy path', () => {
    const wrapper = mountPlain('alpha\n\nbeta', [1, 2, 3]);
    const outside = document.createElement('p');
    outside.textContent = 'OUTSIDE_PROSE';
    host.append(outside);
    const firstText = [...wrapper.querySelector('.hl-text')!.childNodes].find(n => (n.nodeValue ?? '').length > 0)!;
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.setEnd(outside.firstChild!, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const copied = dispatchCopy(wrapper.querySelector('.hl-text')!);

    expect(copied.defaultPrevented).toBe(false);
    expect(copied.plain).toBeNull();
  });

  it('preserves blank diff rows without diff signs or old/new line numbers', () => {
    const wrapper = document.createElement('div');
    host.append(wrapper);
    app = createApp({
      render: () => h(HighlightedCode, {
        lines: [
          { type: 'ctx', text: 'const a = 1;', oldNo: 1, newNo: 1 },
          { type: 'del', text: '', oldNo: 2 },
          { type: 'add', text: '', newNo: 2 },
          { type: 'add', text: 'const b = 2;', newNo: 3 },
        ],
        lineNumbers: true,
        framed: false,
      }),
    });
    app.mount(wrapper);
    window.getSelection()!.selectAllChildren(wrapper);

    const copied = dispatchCopy(wrapper.querySelector('.hl-text')!);

    expect(copied.defaultPrevented).toBe(true);
    expect(copied.plain).toBe('const a = 1;\n\n\nconst b = 2;');
    expect(copied.html).not.toContain('hl-sign');
    expect(copied.html).not.toContain('hl-gutter');
  });
});
