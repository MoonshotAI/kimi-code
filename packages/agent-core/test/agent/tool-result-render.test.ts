import { describe, expect, it } from 'vitest';

import { renderToolResultForModel } from '../../src/agent/context/tool-result-render';

const text = (t: string) => ({ type: 'text', text: t }) as const;

describe('renderToolResultForModel', () => {
  describe('string output (and its single-text-part history form)', () => {
    it('passes successful output through unchanged', () => {
      expect(renderToolResultForModel({ output: 'hello' })).toEqual([text('hello')]);
      expect(renderToolResultForModel({ output: [text('hello')] })).toEqual([text('hello')]);
    });

    it('prefixes the error status on a newline', () => {
      expect(renderToolResultForModel({ output: 'permission denied', isError: true })).toEqual([
        text('ERROR: Tool execution failed.\npermission denied'),
      ]);
    });

    it('does not double-prefix output that already starts with ERROR:', () => {
      expect(renderToolResultForModel({ output: 'ERROR: no such file', isError: true })).toEqual([
        text('ERROR: no such file'),
      ]);
    });

    it('replaces an empty error output with the combined status', () => {
      expect(renderToolResultForModel({ output: '', isError: true })).toEqual([
        text('ERROR: Tool execution failed. Tool output is empty.'),
      ]);
    });

    it('replaces empty or whitespace-only success output with the placeholder', () => {
      expect(renderToolResultForModel({ output: '' })).toEqual([text('Tool output is empty.')]);
      expect(renderToolResultForModel({ output: '  \n ' })).toEqual([
        text('Tool output is empty.'),
      ]);
    });

    it('is idempotent over the already-placeheld output', () => {
      expect(renderToolResultForModel({ output: 'Tool output is empty.' })).toEqual([
        text('Tool output is empty.'),
      ]);
    });
  });

  describe('content-part array output', () => {
    it('passes a media-bearing array through unchanged on success', () => {
      const parts = [
        text('<image path="/a.png">'),
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,x' } } as const,
      ];
      expect(renderToolResultForModel({ output: parts })).toEqual(parts);
    });

    it('prepends the error status as its own part on a multi-part error', () => {
      const parts = [text('a'), text('b')];
      expect(renderToolResultForModel({ output: parts, isError: true })).toEqual([
        text('ERROR: Tool execution failed.'),
        ...parts,
      ]);
    });

    it('collapses an empty-equivalent array to the placeholder', () => {
      expect(renderToolResultForModel({ output: [] })).toEqual([text('Tool output is empty.')]);
      expect(renderToolResultForModel({ output: [text('   \n')] })).toEqual([
        text('Tool output is empty.'),
      ]);
      expect(renderToolResultForModel({ output: [text('')], isError: true })).toEqual([
        text('ERROR: Tool execution failed. Tool output is empty.'),
      ]);
    });
  });

  describe('note', () => {
    it('joins the note into a text-only result with a newline, keeping one part', () => {
      // Text-only results must stay a single text part: providers serialize
      // that as plain string content (some OpenAI-compatible backends reject
      // arrays on tool messages), and joining providers keep the separator.
      expect(
        renderToolResultForModel({ output: 'body', note: '<system>meta</system>' }),
      ).toEqual([text('body\n<system>meta</system>')]);
    });

    it('does not wrap or alter the note text', () => {
      expect(renderToolResultForModel({ output: 'body', note: 'plain words' })).toEqual([
        text('body\nplain words'),
      ]);
    });

    it('appends the note as its own part after media-bearing output', () => {
      const parts = [
        text('<image path="/a.png">'),
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,x' } } as const,
      ];
      expect(
        renderToolResultForModel({ output: parts, note: '<system>meta</system>' }),
      ).toEqual([...parts, text('<system>meta</system>')]);
    });

    it('joins the note after the error prefix and after the empty placeholder', () => {
      expect(
        renderToolResultForModel({ output: 'oops', isError: true, note: 'n' }),
      ).toEqual([text('ERROR: Tool execution failed.\noops\nn')]);
      expect(renderToolResultForModel({ output: '', note: 'n' })).toEqual([
        text('Tool output is empty.\nn'),
      ]);
    });

    it('ignores an empty note', () => {
      expect(renderToolResultForModel({ output: 'body', note: '' })).toEqual([text('body')]);
    });
  });
});
