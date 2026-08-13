import { describe, expect, it } from 'vitest';
import { composerSchema, docToText, parseClipboardText, posToTextOffset, serializeClipboardSlice, textOffsetToPos, textToDoc } from '../src/lib/composerTextDoc';

describe('composerTextDoc — text ↔ doc', () => {
  it('round-trips plain text through the doc model', () => {
    const cases = ['', 'a', 'hello world', 'a\nb', '\n', 'a\n', '\na', 'a\n\nb', '第一行\n第二行', '  spaced  \n\ttabbed'];
    for (const text of cases) {
      expect(docToText(textToDoc(text))).toBe(text);
    }
  });

  it('models every line as its own paragraph', () => {
    const doc = textToDoc('a\nb\nc');
    expect(doc.childCount).toBe(3);
    expect(doc.firstChild?.type).toBe(composerSchema.nodes.paragraph);
  });

  it('keeps an empty string as a single empty paragraph (schema minimum)', () => {
    const doc = textToDoc('');
    expect(doc.childCount).toBe(1);
    expect(doc.textContent).toBe('');
  });
});

describe('composerTextDoc — char offset ↔ PM position', () => {
  it('maps every caret position of a single-line doc both ways', () => {
    const text = 'hello';
    const doc = textToDoc(text);
    for (let offset = 0; offset <= text.length; offset++) {
      expect(posToTextOffset(doc, textOffsetToPos(doc, offset))).toBe(offset);
    }
  });

  it('round-trips offsets in a multi-line doc', () => {
    const text = 'ab\n\ncde';
    const doc = textToDoc(text);
    for (let offset = 0; offset <= text.length; offset++) {
      expect(posToTextOffset(doc, textOffsetToPos(doc, offset))).toBe(offset);
    }
  });

  it('treats the newline offset as the end of the preceding line', () => {
    const text = 'ab\ncd';
    const doc = textToDoc(text);
    // offset 2 is the '\n' itself — it maps to the end of line 1's text, and
    // offset 3 ('c') to the start of line 2.
    expect(posToTextOffset(doc, textOffsetToPos(doc, 2))).toBe(2);
    expect(posToTextOffset(doc, textOffsetToPos(doc, 3))).toBe(3);
  });

  it('clamps offsets past the end to the document end', () => {
    const doc = textToDoc('ab\ncd');
    expect(posToTextOffset(doc, textOffsetToPos(doc, 999))).toBe(5);
  });

  it('clamps negative offsets to the document start', () => {
    const doc = textToDoc('ab\ncd');
    expect(posToTextOffset(doc, textOffsetToPos(doc, -3))).toBe(0);
  });

  it('keeps the produced positions valid for a TextSelection', () => {
    const text = 'one\ntwo\nthree';
    const doc = textToDoc(text);
    for (let offset = 0; offset <= text.length; offset++) {
      const pos = textOffsetToPos(doc, offset);
      const $pos = doc.resolve(pos);
      // A caret position must sit inside a textblock.
      expect($pos.parent.isTextblock).toBe(true);
    }
  });
});

describe('composerTextDoc — clipboard single-newline contract', () => {
  it('paste parsing preserves consecutive blank lines', () => {
    const slice = parseClipboardText('a\n\nb');
    expect(slice.content.childCount).toBe(3);
    expect(serializeClipboardSlice(slice)).toBe('a\n\nb');
  });

  it('paste parsing normalizes CRLF and lone CR', () => {
    expect(serializeClipboardSlice(parseClipboardText('a\r\nb\rc'))).toBe('a\nb\nc');
  });

  it('paste parsing opens the slice so it merges with the target paragraph', () => {
    const slice = parseClipboardText('x\ny');
    expect(slice.openStart).toBeGreaterThan(0);
    expect(slice.openEnd).toBeGreaterThan(0);
  });

  it('copy serialization joins lines with single newlines (no doubling)', () => {
    const doc = textToDoc('a\nb\nc');
    expect(serializeClipboardSlice(doc.slice(0, doc.content.size))).toBe('a\nb\nc');
  });

  it('serialize/parse round-trips empty and trailing-newline text', () => {
    expect(serializeClipboardSlice(parseClipboardText(''))).toBe('');
    expect(serializeClipboardSlice(parseClipboardText('a\n'))).toBe('a\n');
  });
});
