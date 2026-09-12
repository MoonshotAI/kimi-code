import { describe, expect, it } from 'vitest';

import { sanitizeMcpSchema } from '#/mcpCore/schema-sanitize';

type Schema = Record<string, unknown>;

function props(result: Schema): Record<string, Schema> {
  return result['properties'] as Record<string, Schema>;
}

function prop(result: Schema, name: string): Schema {
  return props(result)[name]!;
}

describe('sanitizeMcpSchema — non-object inputs', () => {
  it('returns null unchanged', () => {
    expect(sanitizeMcpSchema(null)).toBe(null);
  });

  it('returns arrays unchanged', () => {
    expect(sanitizeMcpSchema([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('returns primitives unchanged', () => {
    expect(sanitizeMcpSchema('string')).toBe('string');
    expect(sanitizeMcpSchema(42)).toBe(42);
    expect(sanitizeMcpSchema(true)).toBe(true);
  });
});

describe('sanitizeMcpSchema — missing type filling', () => {
  it('fills in string when no type and no structural hints', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        name: { description: 'User name' },
      },
    });
    expect(prop(result, 'name')['type']).toBe('string');
  });

  it('infers type from enum values', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        mode: { enum: ['fast', 'slow'] },
        count: { enum: [1, 2, 3] },
        enabled: { enum: [true, false] },
      },
    });
    expect(prop(result, 'mode')['type']).toBe('string');
    expect(prop(result, 'count')['type']).toBe('integer');
    expect(prop(result, 'enabled')['type']).toBe('boolean');
  });

  it('infers type from const value', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        kind: { const: 'user' },
        timeout: { const: 30 },
      },
    });
    expect(prop(result, 'kind')['type']).toBe('string');
    expect(prop(result, 'timeout')['type']).toBe('integer');
  });

  it('infers type from structural keywords', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        objProp: { properties: { a: {} } },
        arrProp: { items: { type: 'string' } },
        strProp: { pattern: '^\\w+$' },
        numProp: { minimum: 0 },
      },
    });
    expect(prop(result, 'objProp')['type']).toBe('object');
    expect(prop(result, 'arrProp')['type']).toBe('array');
    expect(prop(result, 'strProp')['type']).toBe('string');
    expect(prop(result, 'numProp')['type']).toBe('number');
  });

  it('does not add type when a combinator key is present', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        any: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        one: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        all: { allOf: [{ type: 'string' }] },
        not: { not: { type: 'string' } },
      },
    });
    expect(prop(result, 'any')['type']).toBeUndefined();
    expect(prop(result, 'one')['type']).toBeUndefined();
    expect(prop(result, 'all')['type']).toBeUndefined();
    expect(prop(result, 'not')['type']).toBeUndefined();
  });
});

describe('sanitizeMcpSchema — tuple items to object', () => {
  it('converts tuple items array to anyOf object', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        size: {
          type: 'array',
          items: [{ type: 'number' }, { type: 'number' }],
        },
      },
    });
    const sizeProp = prop(result, 'size');
    expect(typeof sizeProp['items']).toBe('object');
    expect(Array.isArray(sizeProp['items'])).toBe(false);
    expect(sizeProp['items']).toEqual({
      anyOf: [{ type: 'number' }, { type: 'number' }],
    });
  });

  it('unwraps single-element tuple items array to single schema object', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: [{ type: 'string' }],
        },
      },
    });
    const tagsProp = prop(result, 'tags');
    expect(tagsProp['items']).toEqual({ type: 'string' });
  });
});

describe('sanitizeMcpSchema — mixed enums', () => {
  it('splits mixed type enum into typed anyOf branches', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        mixed: { enum: ['a', 1, true] },
      },
    });
    const mixed = prop(result, 'mixed');
    expect(mixed['anyOf']).toEqual([
      { type: 'string', enum: ['a'] },
      { type: 'integer', enum: [1] },
      { type: 'boolean', enum: [true] },
    ]);
  });
});

describe('sanitizeMcpSchema — recursive and circular schemas', () => {
  it('inlines local $ref and removes definitions buckets', () => {
    const schema = {
      type: 'object',
      properties: {
        user: { $ref: '#/definitions/User' },
      },
      definitions: {
        User: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
        },
      },
    };
    const result = sanitizeMcpSchema(schema);
    expect('definitions' in result).toBe(false);
    expect(prop(result, 'user')).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
    });
  });

  it('handles circular references without throwing', () => {
    const schema = {
      type: 'object',
      properties: {
        node: { $ref: '#/definitions/Node' },
      },
      definitions: {
        Node: {
          type: 'object',
          properties: {
            parent: { $ref: '#/definitions/Node' },
          },
        },
      },
    };
    const result = sanitizeMcpSchema(schema);
    expect('definitions' in result).toBe(false);
    const nodeProp = prop(result, 'node');
    expect(nodeProp['type']).toBe('object');
    const parentProp = prop(nodeProp, 'parent');
    expect(parentProp['type']).toBe('object');
    expect(parentProp['description']).toBe('Circular reference');
  });

  it('handles root self-reference safely', () => {
    const schema = {
      type: 'object',
      properties: {
        self: { $ref: '#' },
      },
    };
    const result = sanitizeMcpSchema(schema);
    const selfProp = prop(result, 'self');
    expect(selfProp['type']).toBe('object');
    const nestedSelf = prop(selfProp, 'self');
    expect(nestedSelf['type']).toBe('object');
    expect(nestedSelf['description']).toBe('Circular reference');
  });

  it('preserves boolean schemas referenced by $ref', () => {
    const schema = {
      type: 'object',
      properties: {
        anything: { $ref: '#/$defs/anyVal' },
        nothing: { $ref: '#/$defs/noVal' },
      },
      $defs: {
        anyVal: true,
        noVal: false,
      },
    };
    const result = sanitizeMcpSchema(schema);
    expect('$defs' in result).toBe(false);
    expect(prop(result, 'anything')).toBe(true);
    expect(prop(result, 'nothing')).toBe(false);
  });
});

describe('sanitizeMcpSchema — coexisting type with unions', () => {
  it('removes type when anyOf is present and leaves branch types intact', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        val: {
          type: 'string',
          anyOf: [{ type: 'string' }, { type: 'null' }],
        },
      },
    });
    const valProp = prop(result, 'val');
    expect(valProp['type']).toBeUndefined();
    expect(valProp['anyOf']).toEqual([{ type: 'string' }, { type: 'null' }]);
  });

  it('propagates parent type to union branches that lack type', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        val: {
          type: 'string',
          anyOf: [{ maxLength: 5 }, { minLength: 10 }],
        },
      },
    });
    const valProp = prop(result, 'val');
    expect(valProp['type']).toBeUndefined();
    expect(valProp['anyOf']).toEqual([
      { type: 'string', maxLength: 5 },
      { type: 'string', minLength: 10 },
    ]);
  });

  it('removes type when oneOf is present and propagates type to branches', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        score: {
          type: 'integer',
          oneOf: [{ maximum: 10 }, { minimum: 100 }],
        },
      },
    });
    const scoreProp = prop(result, 'score');
    expect(scoreProp['type']).toBeUndefined();
    expect(scoreProp['oneOf']).toEqual([
      { type: 'integer', maximum: 10 },
      { type: 'integer', minimum: 100 },
    ]);
  });

  it('converts array type to anyOf', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        val: {
          type: ['string', 'null'],
        },
      },
    });
    const valProp = prop(result, 'val');
    expect(valProp['type']).toBeUndefined();
    expect(valProp['anyOf']).toEqual([{ type: 'string' }, { type: 'null' }]);
  });
});

