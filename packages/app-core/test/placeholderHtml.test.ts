// packages/app-core/test/placeholderHtml.test.ts
import { describe, expect, it } from 'vitest';
import { placeholderHtml, placeholderText } from '../src/lib/placeholderHtml';

describe('placeholderHtml', () => {
  it('passes plain text through, escaping HTML-significant characters', () => {
    expect(placeholderHtml('Type a message…')).toBe('Type a message…');
    expect(placeholderHtml('a & b < c')).toBe('a &amp; b &lt; c');
  });

  it('keeps <kbd> pairs as keycap markup', () => {
    expect(placeholderHtml('Press <kbd>Enter</kbd> to queue')).toBe(
      'Press <kbd>Enter</kbd> to queue',
    );
  });

  it('keeps adjacent <kbd> pairs for multi-key shortcuts', () => {
    expect(
      placeholderHtml('Press <kbd>Enter</kbd> to queue · <kbd>Ctrl</kbd>+<kbd>S</kbd> to inject'),
    ).toBe('Press <kbd>Enter</kbd> to queue · <kbd>Ctrl</kbd>+<kbd>S</kbd> to inject');
  });

  it('escapes the kbd content itself', () => {
    expect(placeholderHtml('<kbd><img src=x onerror=alert(1)></kbd>')).toBe(
      '<kbd>&lt;img src=x onerror=alert(1)&gt;</kbd>',
    );
  });

  it('escapes every other tag — no whitelist beyond exact <kbd> pairs', () => {
    expect(placeholderHtml('<script>alert(1)</script><kbd>Esc</kbd>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;<kbd>Esc</kbd>',
    );
    // Attributes are not part of the subset: an attributed kbd stays literal.
    expect(placeholderHtml('<kbd class="x">K</kbd>')).toBe(
      '&lt;kbd class=&quot;x&quot;&gt;K&lt;/kbd&gt;',
    );
  });

  it('degrades an unclosed <kbd> to literal text instead of swallowing the line', () => {
    expect(placeholderHtml('Press <kbd>Enter to queue')).toBe('Press &lt;kbd&gt;Enter to queue');
  });
});

describe('placeholderText', () => {
  it('strips kbd markers, keeping the key labels', () => {
    expect(
      placeholderText('Press <kbd>Enter</kbd> to queue · <kbd>Ctrl</kbd>+<kbd>S</kbd> to inject'),
    ).toBe('Press Enter to queue · Ctrl+S to inject');
  });

  it('leaves plain text untouched', () => {
    expect(placeholderText('输入消息…')).toBe('输入消息…');
  });
});
