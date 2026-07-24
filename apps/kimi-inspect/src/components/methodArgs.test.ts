import { describe, expect, it } from 'vitest';

import { buildArgs, parseParamFields, smartParse } from './methodArgs';

describe('parseParamFields', () => {
  it('parses a single named parameter', () => {
    expect(parseParamFields('sessionId')).toEqual([{ kind: 'value', name: 'sessionId' }]);
  });

  it('parses several named parameters', () => {
    expect(parseParamFields('id, decision')).toEqual([
      { kind: 'value', name: 'id' },
      { kind: 'value', name: 'decision' },
    ]);
  });

  it('keeps declared defaults', () => {
    expect(parseParamFields("count = 1, mode = 'auto'")).toEqual([
      { kind: 'value', name: 'count', defaultValue: '1' },
      { kind: 'value', name: 'mode', defaultValue: "'auto'" },
    ]);
  });

  it('does not split commas inside defaults', () => {
    expect(parseParamFields("ids = ['a', 'b'], flag")).toEqual([
      { kind: 'value', name: 'ids', defaultValue: "['a', 'b']" },
      { kind: 'value', name: 'flag' },
    ]);
  });

  it('expands a destructured object parameter into keys', () => {
    expect(parseParamFields('{ workspaceId, limit }')).toEqual([
      { kind: 'object', name: '{ workspaceId, limit }', keys: ['workspaceId', 'limit'] },
    ]);
  });

  it('strips key defaults and renames in object patterns', () => {
    expect(parseParamFields('{ limit = 10, workspaceId: ws }')).toEqual([
      {
        kind: 'object',
        name: '{ limit = 10, workspaceId: ws }',
        keys: ['limit', 'workspaceId'],
      },
    ]);
  });

  it('keeps the object-pattern default', () => {
    expect(parseParamFields('{ a, b } = {}')).toEqual([
      { kind: 'object', name: '{ a, b } = {}', keys: ['a', 'b'], defaultValue: '{}' },
    ]);
  });

  it('drops rest elements inside object patterns', () => {
    expect(parseParamFields('{ a, ...rest }')).toEqual([
      { kind: 'object', name: '{ a, ...rest }', keys: ['a'] },
    ]);
  });

  it('falls back to raw for rest and array patterns', () => {
    expect(parseParamFields('...args')).toEqual([{ kind: 'raw', label: '...args' }]);
    expect(parseParamFields('[a, b]')).toEqual([{ kind: 'raw', label: '[a, b]' }]);
  });

  it('returns no fields for empty params', () => {
    expect(parseParamFields('')).toEqual([]);
  });
});

describe('smartParse', () => {
  it('parses JSON values', () => {
    expect(smartParse('5')).toBe(5);
    expect(smartParse('true')).toBe(true);
    expect(smartParse('{"a":1}')).toEqual({ a: 1 });
    expect(smartParse('"x"')).toBe('x');
  });

  it('passes non-JSON through as a plain string', () => {
    expect(smartParse('main')).toBe('main');
    expect(smartParse('k2-thinking')).toBe('k2-thinking');
  });
});

describe('buildArgs', () => {
  it('builds a single argument from a value field', () => {
    const fields = parseParamFields('sessionId');
    expect(buildArgs(fields, { '0': 'abc' })).toEqual(['abc']);
  });

  it('assembles a destructured object from its key fields', () => {
    const fields = parseParamFields('{ workspaceId, limit }');
    expect(buildArgs(fields, { '0.workspaceId': 'ws1', '0.limit': '5' })).toEqual([
      { workspaceId: 'ws1', limit: 5 },
    ]);
  });

  it('drops empty keys and omits a fully-empty object', () => {
    const fields = parseParamFields('{ workspaceId, limit }');
    expect(buildArgs(fields, { '0.limit': '5' })).toEqual([{ limit: 5 }]);
    expect(buildArgs(fields, {})).toEqual([]);
  });

  it('uses declared defaults for empty value fields', () => {
    const fields = parseParamFields("count = 1, mode = 'auto'");
    expect(buildArgs(fields, {})).toEqual([1, 'auto']);
    expect(buildArgs(fields, { '1': 'yolo' })).toEqual([1, 'yolo']);
  });

  it('truncates trailing empty params but keeps interior holes', () => {
    const fields = parseParamFields('a, b, c');
    expect(buildArgs(fields, { '0': 'x' })).toEqual(['x']);
    // Interior hole: `b` empty, `c` filled — the hole serializes as null.
    expect(JSON.parse(JSON.stringify(buildArgs(fields, { '0': 'x', '2': 'z' })))).toEqual([
      'x',
      null,
      'z',
    ]);
  });

  it('parses raw fallback fields as strict JSON', () => {
    const fields = parseParamFields('...args');
    expect(buildArgs(fields, { '0': '[1, 2]' })).toEqual([[1, 2]]);
    expect(() => buildArgs(fields, { '0': 'not json' })).toThrow();
  });
});
