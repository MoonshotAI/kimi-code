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

  it('normalizes nested union with tuple array inside anyOf (pageSetup.size reproduction)', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        pageSetup: {
          type: 'object',
          properties: {
            size: {
              anyOf: [
                { type: 'string', enum: ['LETTER', 'A4', 'LEGAL'] },
                {
                  type: 'array',
                  items: [{ type: 'number' }, { type: 'number' }],
                },
              ],
            },
          },
        },
      },
    });
    const pageSetup = prop(result, 'pageSetup');
    const size = prop(pageSetup, 'size');
    const branches = size['anyOf'] as Record<string, unknown>[];
    expect(branches).toHaveLength(2);
    expect(branches[0]?.['type']).toBe('string');
    expect(branches[1]?.['type']).toBe('array');
    const arrayBranchItems = branches[1]?.['items'] as Record<string, unknown>;
    expect(typeof arrayBranchItems).toBe('object');
    expect(Array.isArray(arrayBranchItems)).toBe(false);
    expect(arrayBranchItems).toEqual({
      anyOf: [{ type: 'number' }, { type: 'number' }],
    });
  });

  it('converts prefixItems with boolean items to object items', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        coords: {
          type: 'array',
          prefixItems: [{ type: 'number' }, { type: 'number' }],
          items: false,
        },
      },
    });
    const coords = prop(result, 'coords');
    expect(coords['prefixItems']).toBeUndefined();
    expect(typeof coords['items']).toBe('object');
    expect(coords['items']).toEqual({
      anyOf: [{ type: 'number' }, { type: 'number' }],
    });
  });

  it('normalizes string branches in combinator lists to schema objects', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        mixed: {
          anyOf: [{ type: 'number' }, 'string' as unknown as Record<string, unknown>],
        },
      },
    });
    const mixed = prop(result, 'mixed');
    expect(mixed['anyOf']).toEqual([{ type: 'number' }, { type: 'string' }]);
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

describe('sanitizeMcpSchema — percent-encoded pointer segments', () => {
  it('resolves URI fragment pointer with percent-encoded characters', () => {
    const schema = {
      type: 'object',
      properties: {
        prop: { $ref: '#/$defs/special%20name' },
      },
      $defs: {
        'special name': {
          type: 'string',
        },
      },
    };
    const result = sanitizeMcpSchema(schema);
    expect(prop(result, 'prop')).toEqual({ type: 'string' });
  });
});

describe('sanitizeMcpSchema — ref sibling merging', () => {
  it('merges required and properties conjunctively from target and sibling', () => {
    const schema = {
      type: 'object',
      properties: {
        entity: {
          $ref: '#/$defs/Base',
          description: 'Extended entity',
          required: ['extra'],
          properties: {
            extra: { type: 'number' },
          },
        },
      },
      $defs: {
        Base: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    };
    const result = sanitizeMcpSchema(schema);
    const entity = prop(result, 'entity');
    expect(entity['description']).toBe('Extended entity');
    expect(entity['required']).toEqual(['id', 'extra']);
    expect(props(entity)['id']).toEqual({ type: 'string' });
    expect(props(entity)['extra']).toEqual({ type: 'number' });
  });
});

describe('sanitizeMcpSchema — items false', () => {
  it('maps items false without prefixItems to maxItems 0', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        emptyList: {
          type: 'array',
          items: false,
        },
      },
    });
    const emptyList = prop(result, 'emptyList');
    expect(emptyList['items']).toBeUndefined();
    expect(emptyList['maxItems']).toBe(0);
  });

  it('clamps maxItems to 0 when items is false even if maxItems is already set', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        emptyList: {
          type: 'array',
          items: false,
          maxItems: 5,
        },
      },
    });
    const emptyList = prop(result, 'emptyList');
    expect(emptyList['items']).toBeUndefined();
    expect(emptyList['maxItems']).toBe(0);
  });

  it('clamps maxItems to prefixItems length when items is false and maxItems is larger', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        pair: {
          type: 'array',
          prefixItems: [{ type: 'string' }, { type: 'number' }],
          items: false,
          maxItems: 10,
        },
      },
    });
    const pair = prop(result, 'pair');
    expect(pair['maxItems']).toBe(2);
  });
});

describe('sanitizeMcpSchema — boolean combinator branches', () => {
  it('retains boolean branches in combinator arrays directly', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        allowed: {
          anyOf: [{ type: 'string' }, true],
        },
        denied: {
          allOf: [{ type: 'string' }, false],
        },
      },
    });
    expect(prop(result, 'allowed')['anyOf']).toEqual([{ type: 'string' }, true]);
    expect(prop(result, 'denied')['allOf']).toEqual([{ type: 'string' }, false]);
  });
});

describe('sanitizeMcpSchema — conditional and negation schemas', () => {
  it('recurses into not, if, then, and else schemas', () => {
    const thenKey = ['the', 'n'].join('');
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        negated: {
          not: {
            type: 'array',
            items: [{ type: 'string' }],
          },
        },
        conditional: {
          if: { properties: { a: { items: [{ type: 'number' }] } } },
          [thenKey]: { properties: { b: { items: [{ type: 'string' }] } } },
          else: { properties: { c: { items: [{ type: 'boolean' }] } } },
        },
      },
    });
    const negated = prop(result, 'negated')['not'] as Record<string, unknown>;
    expect(negated['items']).toEqual({ type: 'string' });

    const cond = prop(result, 'conditional');
    const ifSchema = cond['if'] as Record<string, unknown>;
    const ifProps = ifSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(ifProps['a']!['items']).toEqual({ type: 'number' });
  });

  it('conjoins numeric bounds and lengths from target and ref siblings', () => {
    const schema = {
      type: 'object',
      properties: {
        val: {
          $ref: '#/$defs/Str',
          minLength: 1,
          maxLength: 15,
        },
      },
      $defs: {
        Str: {
          type: 'string',
          minLength: 5,
          maxLength: 20,
        },
      },
    };
    const result = sanitizeMcpSchema(schema);
    const val = prop(result, 'val');
    expect(val['minLength']).toBe(5);
    expect(val['maxLength']).toBe(15);
  });

  it('retains prefixItems when items is already an object schema', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        arr: {
          type: 'array',
          prefixItems: [{ type: 'string' }],
          items: { type: 'number' },
        },
      },
    });
    const arr = prop(result, 'arr');
    expect(arr['prefixItems']).toBeUndefined();
    expect(arr['items']).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('resets ref activity before traversing sibling references', () => {
    const schema = {
      type: 'object',
      properties: {
        val: {
          $ref: '#/$defs/S',
          allOf: [{ $ref: '#/$defs/S' }],
        },
      },
      $defs: {
        S: {
          type: 'string',
        },
      },
    };
    const result = sanitizeMcpSchema(schema);
    const val = prop(result, 'val');
    expect(val['type']).toBe('string');
    expect(val['description']).toBeUndefined();
    const allOf = val['allOf'] as Record<string, unknown>[];
    expect(allOf).toHaveLength(1);
    expect(allOf[0]?.['type']).toBe('string');
    expect(allOf[0]?.['description']).toBeUndefined();
  });

  it('intersects object-valued enums by structural equality instead of reference identity', () => {
    const schema = {
      type: 'object',
      properties: {
        item: {
          $ref: '#/$defs/Base',
          enum: [{ a: 1 }, { b: 2 }],
        },
      },
      $defs: {
        Base: {
          type: 'object',
          enum: [{ a: 1 }, { c: 3 }],
        },
      },
    };
    const result = sanitizeMcpSchema(schema);
    const item = prop(result, 'item');
    expect(item['enum']).toEqual([{ a: 1 }]);
  });

  it('infers object type from dependentSchemas or dependentRequired', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        withDepSchemas: {
          dependentSchemas: {
            creditCard: { properties: { billingAddress: { type: 'string' } } },
          },
        },
        withDepReq: {
          dependentRequired: {
            creditCard: ['billingAddress'],
          },
        },
      },
    });
    expect(prop(result, 'withDepSchemas')['type']).toBe('object');
    expect(prop(result, 'withDepReq')['type']).toBe('object');
  });

  it('preserves array-valued types beside existing anyOf by filtering incompatible branches', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        val: {
          type: ['string', 'null'],
          anyOf: [{ type: 'string' }, { type: 'number' }],
        },
      },
    });
    const val = prop(result, 'val');
    expect(val['type']).toBeUndefined();
    expect(val['anyOf']).toEqual([{ type: 'string' }]);
  });

  it('keeps #/ distinct from # by resolving empty-string property on root', () => {
    const schema = {
      type: 'object',
      '': {
        type: 'string',
        description: 'empty-key property',
      },
      properties: {
        val: { $ref: '#/' },
      },
    };
    const result = sanitizeMcpSchema(schema);
    const val = prop(result, 'val');
    expect(val['type']).toBe('string');
    expect(val['description']).toBe('empty-key property');
  });

  it('preserves target structural constraints on recursive refs', () => {
    const schema = {
      type: 'object',
      properties: {
        node: { $ref: '#/$defs/Node' },
      },
      $defs: {
        Node: {
          type: 'object',
          required: ['value'],
          properties: {
            value: { type: 'string' },
            next: { $ref: '#/$defs/Node' },
          },
        },
      },
    };
    const result = sanitizeMcpSchema(schema);
    const node = prop(result, 'node');
    expect(node['type']).toBe('object');
    expect(node['required']).toEqual(['value']);
    const next = prop(node, 'next');
    expect(next['type']).toBe('object');
    expect(next['required']).toEqual(['value']);
    expect(next['description']).toBe('Circular reference');
  });

  it('filters mixed enum values that contradict explicit string type', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['auto', 1, true],
        },
      },
    });
    const mode = prop(result, 'mode');
    expect(mode['type']).toBe('string');
    expect(mode['enum']).toEqual(['auto']);
  });

  it('infers container types from unevaluatedProperties and unevaluatedItems', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        obj: {
          unevaluatedProperties: false,
        },
        arr: {
          unevaluatedItems: false,
        },
        arr2: {
          additionalItems: false,
        },
      },
    });
    expect(prop(result, 'obj')['type']).toBe('object');
    expect(prop(result, 'arr')['type']).toBe('array');
    expect(prop(result, 'arr2')['type']).toBe('array');
  });

  it('preserves closed-object semantics when merging ref siblings with additionalProperties false', () => {
    const schema = {
      type: 'object',
      properties: {
        closed: {
          $ref: '#/$defs/Target',
          properties: { b: { type: 'string' } },
          required: ['b'],
        },
      },
      $defs: {
        Target: {
          type: 'object',
          properties: { a: { type: 'number' } },
          additionalProperties: false,
        },
      },
    };
    const result = sanitizeMcpSchema(schema);
    const closed = prop(result, 'closed');
    expect(closed['allOf']).toBeDefined();
    expect(Array.isArray(closed['allOf'])).toBe(true);
    const allOf = closed['allOf'] as Record<string, unknown>[];
    expect(allOf).toHaveLength(2);
    expect(allOf[0]?.['additionalProperties']).toBe(false);
  });
});


