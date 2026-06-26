import { describe, expect, it } from 'vitest';

import { sanitizeMcpSchema } from '../../src/mcp/schema-sanitize';

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

  it('returns arrays unchanged (invalid schema, but identity)', () => {
    expect(sanitizeMcpSchema([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('returns primitives unchanged', () => {
    expect(sanitizeMcpSchema('string')).toBe('string');
    expect(sanitizeMcpSchema(42)).toBe(42);
    expect(sanitizeMcpSchema(true)).toBe(true);
  });
});

describe('sanitizeMcpSchema — missing type filling', () => {
  it('fills in "string" when no type and no structural hints', () => {
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
        mixed: { enum: [1, 'a'] },
      },
    });
    expect(prop(result, 'mode')['type']).toBe('string');
    expect(prop(result, 'count')['type']).toBe('integer');
    expect(prop(result, 'enabled')['type']).toBe('boolean');
    expect(prop(result, 'mixed')['type']).toBe('string');
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

  it('does not overwrite an existing type', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['a', 'b'] },
      },
    });
    expect(prop(result, 'name')['type']).toBe('string');
  });
});

describe('sanitizeMcpSchema — $ref dereferencing', () => {
  it('inlines local $ref pointers and strips $defs', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        user: { $ref: '#/$defs/User' },
      },
      $defs: {
        User: {
          type: 'object',
          properties: {
            name: {},
            age: {},
          },
        },
      },
    });

    expect('$defs' in result).toBe(false);
    const userProp = prop(result, 'user');
    expect(userProp['type']).toBe('object');
    const userProps = props(userProp);
    expect(userProps['name']!['type']).toBe('string');
    expect(userProps['age']!['type']).toBe('string');
  });

  it('preserves sibling keys alongside $ref', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        item: { $ref: '#/$defs/Item', description: 'overridden' },
      },
      $defs: {
        Item: { type: 'string' },
      },
    });
    const itemProp = prop(result, 'item');
    expect(itemProp['type']).toBe('string');
    expect(itemProp['description']).toBe('overridden');
  });

  it('handles nested $ref chains', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/A' },
      },
      $defs: {
        A: { $ref: '#/$defs/B' },
        B: { type: 'integer' },
      },
    });
    expect(prop(result, 'a')['type']).toBe('integer');
  });

  it('leaves remote $ref untouched', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        remote: { $ref: 'https://example.com/schema.json' },
      },
    });
    expect(prop(result, 'remote')['$ref']).toBe('https://example.com/schema.json');
  });

  it('strips legacy "definitions" bucket', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {},
      definitions: { Foo: { type: 'string' } },
    });
    expect('definitions' in result).toBe(false);
  });

  it('throws on unresolvable local $ref', () => {
    expect(() =>
      sanitizeMcpSchema({
        type: 'object',
        properties: {
          broken: { $ref: '#/$defs/Missing' },
        },
      }),
    ).toThrow(/Unable to resolve reference path/);
  });
});

describe('sanitizeMcpSchema — nested arrays and items', () => {
  it('fills type on array items (object form)', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        tags: { type: 'array', items: { description: 'a tag' } },
      },
    });
    const tagsProp = prop(result, 'tags');
    expect((tagsProp['items'] as Schema)['type']).toBe('string');
  });

  it('fills type on array items (array form / tuple)', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        pair: { type: 'array', items: [{ description: 'first' }, { type: 'number' }] },
      },
    });
    const pairProp = prop(result, 'pair');
    const items = pairProp['items'] as Schema[];
    expect(items[0]!['type']).toBe('string');
    expect(items[1]!['type']).toBe('number');
  });

  it('fills type on additionalProperties (object form)', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      additionalProperties: { description: 'dynamic value' },
    });
    expect((result['additionalProperties'] as Schema)['type']).toBe('string');
  });
});

describe('sanitizeMcpSchema — regression: issue #792 (n8n anyOf)', () => {
  // Reproduces the exact schema shape from issue #792 where n8n emits a
  // property with `anyOf` whose branches lack explicit `type`. Moonshot's
  // validator rejects this because `anyOf` branches must be objects.
  it('fills type on anyOf/oneOf/allOf branches', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        pageSetup: {
          type: 'object',
          properties: {
            size: {
              anyOf: [
                { description: 'small' },
                { description: 'large', format: 'paper-size' },
              ],
            },
          },
        },
      },
    });

    const pageSetup = prop(result, 'pageSetup');
    const size = prop(pageSetup, 'size');
    const branches = size['anyOf'] as Schema[];
    expect(branches[0]!['type']).toBe('string');
    expect(branches[1]!['type']).toBe('string');
  });

  it('recurses into anyOf branches that contain nested properties', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        config: {
          anyOf: [
            {
              properties: {
                host: { description: 'hostname' },
                port: { minimum: 0 },
              },
            },
          ],
        },
      },
    });

    const config = prop(result, 'config');
    // The config property uses a combinator (anyOf), so no type is added at
    // the config level. Inside the branch, nested properties get filled.
    expect(config['type']).toBeUndefined();
    const branch = (config['anyOf'] as Schema[])[0]!;
    const branchProps = props(branch);
    expect(branchProps['host']!['type']).toBe('string');
    expect(branchProps['port']!['type']).toBe('number');
  });
});

describe('sanitizeMcpSchema — immutability', () => {
  it('never mutates the input schema', () => {
    const input = {
      type: 'object',
      properties: {
        name: { description: 'test' },
      },
    };
    const inputCopy = structuredClone(input);
    sanitizeMcpSchema(input);
    expect(input).toEqual(inputCopy);
  });
});

describe('sanitizeMcpSchema — integer/number unification', () => {
  it('classifies {integer, number} mixed enum as "number"', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        value: { enum: [1, 2.5] },
      },
    });
    expect(prop(result, 'value')['type']).toBe('number');
  });

  it('classifies pure integer enum as "integer"', () => {
    const result = sanitizeMcpSchema({
      type: 'object',
      properties: {
        value: { enum: [1, 2, 3] },
      },
    });
    expect(prop(result, 'value')['type']).toBe('integer');
  });
});

describe('sanitizeMcpSchema — recursive / circular schemas', () => {
  it('handles circular references without throwing or stack overflowing', () => {
    const schema = {
      type: 'object',
      properties: {
        children: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'string' },
              { $ref: '#/definitions/__schema0' },
            ],
          },
        },
      },
      definitions: {
        __schema0: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            children: {
              type: 'array',
              items: {
                anyOf: [
                  { type: 'string' },
                  { $ref: '#/definitions/__schema0' },
                ],
              },
            },
          },
        },
      },
    };

    const result = sanitizeMcpSchema(schema);
    
    // Check that definitions got stripped
    expect('definitions' in result).toBe(false);
    
    // Check that children exists
    const children = prop(result, 'children');
    expect(children['type']).toBe('array');
    
    // Verify circular reference was safely resolved to type object at the second level
    const items = children['items'] as Schema;
    const branches = items['anyOf'] as Schema[];
    expect(branches[0]!['type']).toBe('string');
    expect(branches[1]!['type']).toBe('object');
    
    // Drill down to the circular reference
    const nestedChildren = prop(branches[1], 'children');
    expect(nestedChildren['type']).toBe('array');
    const nestedItems = nestedChildren['items'] as Schema;
    const nestedBranches = nestedItems['anyOf'] as Schema[];
    expect(nestedBranches[0]!['type']).toBe('string');
    expect(nestedBranches[1]!['type']).toBe('object');
    expect(nestedBranches[1]!['description']).toBe('Circular reference');
  });

  it('handles root self-recursive references ($ref: "#") safely', () => {
    const schema = {
      type: 'object',
      properties: {
        self: { $ref: '#' },
      },
    };

    const result = sanitizeMcpSchema(schema);

    // Verify circular reference at the root level was safely resolved at the nested level
    const selfProp = prop(result, 'self');
    expect(selfProp['type']).toBe('object');
    
    const nestedSelf = prop(selfProp, 'self');
    expect(nestedSelf['type']).toBe('object');
    expect(nestedSelf['description']).toBe('Circular reference');
  });
});
