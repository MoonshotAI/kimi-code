import { describe, expect, it } from 'vitest';
import { Slice } from 'prosemirror-model';
import {
  PASTED_TEXT_MIN_CHARS,
  PASTED_TEXT_MIN_LINES,
  composerSchema,
  docToText,
  expandPastedTextLinks,
  isLongPastedText,
  parseComposerSnapshot,
  pastedTextCharCount,
  pastedTextLineCount,
  pastedTextNode,
  pastedTextPillLabel,
  posToTextOffset,
  serializeClipboardSlice,
  serializePastedText,
  textToDoc,
} from '../../src/model';

const BODY = 'first line (with) [brackets]\n  second line % & <tag>\n\nlast';

function docWithPaste(text: string) {
  return composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, [composerSchema.text('see '), pastedTextNode({ text }), composerSchema.text(' please')]),
  ]);
}

describe('isLongPastedText', () => {
  it('keeps ordinary pastes inline', () => {
    expect(isLongPastedText('hello world')).toBe(false);
    expect(isLongPastedText('a'.repeat(PASTED_TEXT_MIN_CHARS - 1))).toBe(false);
    expect(isLongPastedText('x\n'.repeat(PASTED_TEXT_MIN_LINES - 2))).toBe(false);
  });

  it('folds pastes past the character or line limit', () => {
    expect(isLongPastedText('a'.repeat(PASTED_TEXT_MIN_CHARS))).toBe(true);
    expect(isLongPastedText('x\n'.repeat(PASTED_TEXT_MIN_LINES - 1))).toBe(true);
  });
});

describe('pasted text pill label', () => {
  it('uses the first non-empty line, truncated', () => {
    expect(pastedTextPillLabel('\n\n  hello  \nworld')).toBe('hello');
    expect(pastedTextPillLabel('a'.repeat(100)).length).toBeLessThan(30);
    expect(pastedTextPillLabel('\n \n')).toBe('…');
  });

  it('bounds the work on a huge first line', () => {
    const label = pastedTextPillLabel(`  ${'é'.repeat(5_000_000)}`);
    expect(label).toBe(`${'é'.repeat(23)}…`);
    expect(pastedTextPillLabel('short line   \nnext')).toBe('short line');
    expect(pastedTextPillLabel('👍🏽'.repeat(30))).toBe(`${'👍🏽'.repeat(23)}…`);
  });

  it('counts characters by code point', () => {
    expect(pastedTextCharCount('abc')).toBe(3);
    expect(pastedTextCharCount('你好\n😀')).toBe(4);
  });

  it('counts lines', () => {
    expect(pastedTextLineCount('one')).toBe(1);
    expect(pastedTextLineCount('one\ntwo\n')).toBe(3);
  });
});

describe('pasted text wire form', () => {
  it('round-trips through the wire text', () => {
    const doc = docWithPaste(BODY);
    const wire = docToText(doc);
    expect(wire).toBe(`see ${serializePastedText({ text: BODY })} please`);
    expect(wire).not.toContain('\n');
    const revived = textToDoc(wire, { reviveMentions: true });
    expect(revived.eq(doc)).toBe(true);
  });

  it('maps positions using the serialized length', () => {
    const doc = docWithPaste(BODY);
    const afterPill = 1 + 'see '.length + 1;
    expect(posToTextOffset(doc, afterPill)).toBe('see '.length + serializePastedText({ text: BODY }).length);
  });

  it('expands to the verbatim text for submit', () => {
    const wire = docToText(docWithPaste(BODY));
    expect(expandPastedTextLinks(wire)).toBe(`see ${BODY} please`);
    expect(expandPastedTextLinks('no links here')).toBe('no links here');
  });

  it('expands a pill typed right after ! or a backslash', () => {
    for (const prefix of ['!', '\\']) {
      const doc = composerSchema.node('doc', null, [
        composerSchema.node('paragraph', null, [composerSchema.text(`see ${prefix}`), pastedTextNode({ text: BODY })]),
      ]);
      const wire = docToText(doc);
      expect(expandPastedTextLinks(wire)).toBe(`see ${prefix}${BODY}`);
      expect(textToDoc(wire, { reviveMentions: true }).eq(doc)).toBe(true);
    }
  });

  it('copies as the verbatim text', () => {
    const slice = new Slice(docWithPaste(BODY).content, 0, 0);
    expect(serializeClipboardSlice(slice)).toBe(`see ${BODY} please`);
  });

  it('survives a draft snapshot', () => {
    const doc = docWithPaste(BODY);
    const parsed = parseComposerSnapshot({ version: 1, doc: doc.toJSON(), attachments: [], attachmentOrder: [] });
    expect(parsed).not.toBeNull();
  });
});
