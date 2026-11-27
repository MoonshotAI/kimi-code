// @vitest-environment jsdom
import { createApp, h, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HighlightedCode from '../src/HighlightedCode.vue';

vi.mock('@moonshot-ai/app-core/composables', () => ({
  useIsDark: () => ref(false),
}));

vi.mock('@moonshot-ai/app-core/lib', () => ({
  codeLanguageFromPath: () => undefined,
  logWarn: vi.fn(),
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

function mountCode(code: string | string[], lineNumbers: number[] = [1, 2, 3, 4, 5, 6, 7]): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'fp-body';
  host.append(wrapper);
  app = createApp({ render: () => h(HighlightedCode, { code, lineNumbers, framed: false }) });
  app.mount(wrapper);
  return wrapper;
}

function selectAllAndCopy(wrapper: HTMLElement): ClipboardPayload {
  window.getSelection()!.selectAllChildren(wrapper);
  return dispatchCopy(wrapper.querySelector('.hl-text')!);
}

describe('HighlightedCode copy serialization with string code prop', () => {
  it('preserves blank lines, HTML escaping, and the trailing newline for LF input', () => {
    const source = 'if (a < b && c > d) {\n  "x & y"\n}\n\nexport const third = 3;\n';
    const wrapper = mountCode(source);

    const copied = selectAllAndCopy(wrapper);

    expect(copied.defaultPrevented).toBe(true);
    expect(copied.plain).toBe(source);
    expect(copied.html).not.toContain('hl-gutter');
    expect(copied.html).toContain('&lt;');
    expect(copied.html).toContain('&gt;');
    expect(copied.html).toContain('&amp;');
    expect(copied.html).toContain('<br>');
  });

  it('keeps LF input without a trailing newline free of an extra terminator', () => {
    const source = 'alpha\n\nbeta';
    const wrapper = mountCode(source);

    const copied = selectAllAndCopy(wrapper);

    expect(copied.defaultPrevented).toBe(true);
    expect(copied.plain).toBe(source);
  });

  it('preserves CRLF line endings and the trailing CRLF for multi-line input without doubling CR', () => {
    const source = 'export const first = 1;\r\n\r\nexport const second = 2;\r\n';
    const wrapper = mountCode(source);

    const copied = selectAllAndCopy(wrapper);

    expect(copied.defaultPrevented).toBe(true);
    expect(copied.plain).toBe(source);
    expect(copied.plain).not.toContain('\r\r\n');
  });

  it('preserves a single-line CRLF string without leaving a bare carriage return', () => {
    const source = 'echo hello\r\n';
    const wrapper = mountCode(source);

    const copied = selectAllAndCopy(wrapper);

    expect(copied.defaultPrevented).toBe(true);
    expect(copied.plain).toBe(source);
  });

  it('preserves mixed CRLF and LF separators byte-for-byte on select-all', () => {
    for (const source of ['a\r\nb\nc\n', 'a\nb\r\nc', 'a\r\n\nb\nc\r\n']) {
      const wrapper = mountCode(source);
      const copied = selectAllAndCopy(wrapper);
      expect(copied.defaultPrevented).toBe(true);
      expect(copied.plain).toBe(source);
      app!.unmount();
      wrapper.remove();
    }
  });

  it('preserves per-row separators in partial mixed-EOL selections without adding trailing EOL on clamped rows', () => {
    const wrapper = mountCode('aa\r\nbb\ncc\r\ndd\n');
    const texts = [...wrapper.querySelectorAll('.hl-text')];
    const firstText = [...texts[0]!.childNodes].find(n => (n.nodeValue ?? '').length > 0)!;
    const thirdText = [...texts[2]!.childNodes].find(n => (n.nodeValue ?? '').length > 0)!;
    const range = document.createRange();
    range.setStart(firstText, 1);
    range.setEnd(thirdText, 1);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const copied = dispatchCopy(texts[0]!);

    expect(copied.defaultPrevented).toBe(true);
    expect(copied.plain).toBe('a\r\nbb\nc');
  });

  it('does not append a trailing separator when a mixed-EOL partial selection ends at a middle row end', () => {
    const wrapper = mountCode('aa\r\nbb\ncc\r\n');
    const texts = [...wrapper.querySelectorAll('.hl-text')];
    const firstText = [...texts[0]!.childNodes].find(n => (n.nodeValue ?? '').length > 0)!;
    const secondText = [...texts[1]!.childNodes].find(n => (n.nodeValue ?? '').length > 0)!;
    const range = document.createRange();
    range.setStart(firstText, 1);
    range.setEnd(secondText, secondText.nodeValue!.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const copied = dispatchCopy(texts[0]!);

    expect(copied.defaultPrevented).toBe(true);
    expect(copied.plain).toBe('a\r\nbb');
  });

  it('uses CRLF inside a partial selection across blank rows without appending a trailing CRLF', () => {
    const wrapper = mountCode('alpha\r\n\r\nbeta\r\n');
    const texts = [...wrapper.querySelectorAll('.hl-text')];
    const firstText = [...texts[0]!.childNodes].find(n => (n.nodeValue ?? '').length > 0)!;
    const thirdText = [...texts[2]!.childNodes].find(n => (n.nodeValue ?? '').length > 0)!;
    const range = document.createRange();
    range.setStart(firstText, 2);
    range.setEnd(thirdText, 3);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const copied = dispatchCopy(texts[0]!);

    expect(copied.defaultPrevented).toBe(true);
    expect(copied.plain).toBe('pha\r\n\r\nbet');
  });
});

describe('HighlightedCode copy serialization with array code and diff props', () => {
  it('keeps array row behavior unchanged for LF and CRLF inputs', () => {
    const lf = 'alpha\n\nbeta\n';
    const wrapper = mountCode(lf.split('\n'));
    expect(selectAllAndCopy(wrapper).plain).toBe(lf);
    app!.unmount();
    wrapper.remove();

    const crlf = 'alpha\r\n\r\nbeta\r\n';
    const crlfWrapper = mountCode(crlf.split('\n'));
    expect(selectAllAndCopy(crlfWrapper).plain).toBe(crlf);
  });

  it('preserves blank lines inside a partial selection across rows', () => {
    const wrapper = mountCode('alpha\n\n\nbeta\ngamma');
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
    const wrapper = mountCode('alpha\nbeta\ngamma');
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
    const wrapper = mountCode('alpha\n\nbeta');
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

    const copied = selectAllAndCopy(wrapper);

    expect(copied.defaultPrevented).toBe(true);
    expect(copied.plain).toBe('const a = 1;\n\n\nconst b = 2;');
    expect(copied.html).not.toContain('hl-sign');
    expect(copied.html).not.toContain('hl-gutter');
  });
});
