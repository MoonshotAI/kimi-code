import { describe, expect, it } from 'vitest';

import { renderToolResultForModel } from '../../src/agent/context/tool-result-render';

const text = (t: string) => ({ type: 'text', text: t }) as const;

const ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const EMPTY_STATUS = '<system>Tool output is empty.</system>';
const EMPTY_ERROR_STATUS = '<system>ERROR: Tool execution failed. Tool output is empty.</system>';

describe('renderToolResultForModel', () => {
  describe('string output (and its single-text-part history form)', () => {
    it('passes successful output through unchanged', () => {
      expect(renderToolResultForModel({ output: 'hello' })).toEqual([text('hello')]);
      expect(renderToolResultForModel({ output: [text('hello')] })).toEqual([text('hello')]);
    });

    it('prefixes the wrapped error status on a newline', () => {
      expect(renderToolResultForModel({ output: 'permission denied', isError: true })).toEqual([
        text(`${ERROR_STATUS}\npermission denied`),
      ]);
    });

    it('adds the status uniformly, even when tool output already starts with ERROR:', () => {
      // The <system> wrapper is the harness verdict; the tool's own "ERROR:"
      // text is data. Every failed call gets exactly one wrapped status, so
      // the model never has to guess whether a failure was flagged.
      expect(renderToolResultForModel({ output: 'ERROR: no such file', isError: true })).toEqual([
        text(`${ERROR_STATUS}\nERROR: no such file`),
      ]);
    });

    it('replaces an empty error output with the combined status', () => {
      expect(renderToolResultForModel({ output: '', isError: true })).toEqual([
        text(EMPTY_ERROR_STATUS),
      ]);
    });

    it('replaces empty or whitespace-only success output with the placeholder', () => {
      expect(renderToolResultForModel({ output: '' })).toEqual([text(EMPTY_STATUS)]);
      expect(renderToolResultForModel({ output: '  \n ' })).toEqual([text(EMPTY_STATUS)]);
    });

    it('recognizes the plain record placeholder and emits the wrapped form', () => {
      // The loop layer writes the plain placeholder into records
      // (normalizeToolResult); the projection upgrades it to the wrapped
      // system status rather than double-wrapping or passing it as data.
      expect(renderToolResultForModel({ output: 'Tool output is empty.' })).toEqual([
        text(EMPTY_STATUS),
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

    it('prepends the wrapped error status as its own part on a multi-part error', () => {
      const parts = [text('a'), text('b')];
      expect(renderToolResultForModel({ output: parts, isError: true })).toEqual([
        text(ERROR_STATUS),
        ...parts,
      ]);
    });

    it('collapses an empty-equivalent array to the placeholder', () => {
      expect(renderToolResultForModel({ output: [] })).toEqual([text(EMPTY_STATUS)]);
      expect(renderToolResultForModel({ output: [text('   \n')] })).toEqual([
        text(EMPTY_STATUS),
      ]);
      expect(renderToolResultForModel({ output: [text('')], isError: true })).toEqual([
        text(EMPTY_ERROR_STATUS),
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

    it('joins the note after the error status and after the empty placeholder', () => {
      expect(
        renderToolResultForModel({ output: 'oops', isError: true, note: 'n' }),
      ).toEqual([text(`${ERROR_STATUS}\noops\nn`)]);
      expect(renderToolResultForModel({ output: '', note: 'n' })).toEqual([
        text(`${EMPTY_STATUS}\nn`),
      ]);
    });

    it('ignores an empty note', () => {
      expect(renderToolResultForModel({ output: 'body', note: '' })).toEqual([text('body')]);
    });
  });
});
