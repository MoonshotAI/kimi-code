/**
 * `kosong/provider` Kimi schema dialect — normalization shapes Moonshot's
 * tool validator rejects: the parameters root must be a typed object (so
 * root-level `anyOf`/`oneOf` unions flatten into one object schema), and
 * `type` next to `anyOf`/`oneOf` on nested nodes is folded into the union
 * branches while preserving the parent constraint on every branch.
 * Wiring: pure function, no mocks.
 * Run: pnpm exec vitest run packages/agent-core-v2/test/kosong/provider/kimi-schema.test.ts
 */
import { describe, expect, it } from 'vitest';

import { normalizeKimiToolSchema } from '#/kosong/provider/providers/kimi/kimi-schema';

/**
 * Structure-only view: the variant summary appended to `description` has its
 * own tests, so structural assertions below drop it.
 */
function structureOf(schema: Record<string, unknown>): Record<string, unknown> {
  const { description: _description, ...rest } = normalizeKimiToolSchema(schema);
  return rest;
}

describe('normalizeKimiToolSchema', () => {
  it('flattens a root union into a single typed object root', () => {
    const schema = {
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      description: 'Provide exactly one of the documented input variants.',
      anyOf: [
        {
          type: 'object',
          properties: {
            filename: { type: 'string', minLength: 1 },
            content: { type: 'string', maxLength: 1024 },
          },
          required: ['filename', 'content'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            source_id: { type: 'string', minLength: 1 },
          },
          required: ['source_id'],
          additionalProperties: false,
        },
      ],
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      description: [
        'Provide exactly one of the documented input variants.',
        'Valid argument variants (at least one must match): ' +
          '(1) required: filename, content. (2) required: source_id.',
      ].join('\n\n'),
      properties: {
        filename: { type: 'string', minLength: 1 },
        content: { type: 'string', maxLength: 1024 },
        source_id: { type: 'string', minLength: 1 },
      },
    });
  });

  it('collapses a root required-variant union onto the object root', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
      },
      anyOf: [{ required: ['a'] }, { required: ['b'] }],
    };

    const result = structureOf(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
      },
    });
  });

  it('keeps fields required by every branch of a flattened root union', () => {
    const schema = {
      type: 'object',
      anyOf: [
        {
          type: 'object',
          properties: { id: { type: 'string' }, a: { type: 'string' } },
          required: ['id', 'a'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { id: { type: 'string' }, b: { type: 'string' } },
          required: ['id', 'b'],
          additionalProperties: false,
        },
      ],
    };

    const result = structureOf(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
        a: { type: 'string' },
        b: { type: 'string' },
      },
      required: ['id'],
    });
  });

  it('flattens a root union produced by $ref sibling merging', () => {
    const schema = {
      type: 'object',
      $ref: '#/$defs/Input',
      $defs: {
        Input: {
          anyOf: [
            {
              type: 'object',
              properties: { a: { type: 'string' } },
              required: ['a'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { b: { type: 'string' } },
              required: ['b'],
              additionalProperties: false,
            },
          ],
        },
      },
    };

    const result = structureOf(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
      },
    });
  });

  it('rebuilds an empty object root when a root union has no object branches', () => {
    const schema = {
      type: 'integer',
      anyOf: [{ const: 1.5 }],
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('treats patternProperties branches as unconstrained for undeclared keys', () => {
    const schema = {
      type: 'object',
      anyOf: [
        {
          properties: { value: { type: 'string' } },
          additionalProperties: false,
        },
        {
          patternProperties: { '^value$': { type: 'number' } },
          additionalProperties: false,
        },
      ],
    };

    const result = structureOf(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('omits typeless branch property schemas that type completion would narrow', () => {
    const schema = {
      type: 'object',
      anyOf: [
        {
          properties: { value: { type: 'string' } },
          additionalProperties: false,
        },
        {
          properties: { value: { description: 'Any JSON value' } },
          additionalProperties: false,
        },
      ],
    };

    const result = structureOf(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('keeps typeless enum contributions whose completion is value-exact', () => {
    const schema = {
      type: 'object',
      anyOf: [
        {
          properties: { value: { enum: ['a'] } },
          additionalProperties: false,
        },
        {
          properties: { value: { enum: ['b'] } },
          additionalProperties: false,
        },
      ],
    };

    const result = structureOf(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        value: {
          anyOf: [
            { enum: ['a'], type: 'string' },
            { enum: ['b'], type: 'string' },
          ],
        },
      },
    });
  });

  it('drops required entries for properties omitted from a flattened root union', () => {
    // The property is unconstrained (a patternProperties branch may cover it),
    // so it is omitted — a `required` naming a property that is not in
    // `properties` is rejected outright by the validator.
    const schema = {
      type: 'object',
      anyOf: [
        {
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        {
          patternProperties: { '^value$': { type: 'number' } },
          required: ['value'],
          additionalProperties: false,
        },
      ],
    };

    const result = structureOf(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('flattens a typeless root union with an any-object branch to an open object', () => {
    const schema = {
      anyOf: [true, { required: ['value'] }],
    };

    expect(structureOf(schema)).toEqual({
      type: 'object',
      properties: {},
    });
    // The union accepts any object, so no combination is listed — but the
    // field name would otherwise disappear entirely.
    expect(normalizeKimiToolSchema(schema)['description']).toBe(
      'Fields without their own schema entry:\n- value',
    );
  });

  it('keeps root properties but drops branch constraints when a branch accepts any object', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      anyOf: [
        {},
        {
          properties: { b: { type: 'number' } },
          required: ['b'],
          additionalProperties: false,
        },
      ],
    };

    expect(structureOf(schema)).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
    });
    expect(normalizeKimiToolSchema(schema)['description']).toBe(
      'Fields without their own schema entry:\n- b',
    );
  });

  it('drops an explicit false branch from a nested union', () => {
    const schema = {
      type: 'object',
      properties: {
        x: {
          type: 'object',
          anyOf: [false, { properties: { a: { type: 'string' } } }],
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        x: {
          anyOf: [{ properties: { a: { type: 'string' } }, type: 'object' }],
        },
      },
    });
  });

  it('splits a mixed-type enum branch into per-type variants', () => {
    const schema = {
      type: 'object',
      properties: {
        x: {
          type: ['string', 'number'],
          anyOf: [{ enum: ['a', 1] }],
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        x: {
          anyOf: [
            {
              anyOf: [
                { type: 'string', enum: ['a'] },
                { type: 'integer', enum: [1] },
              ],
            },
          ],
        },
      },
    });
  });

  it('keeps an opaque branch from narrowing the flattened root', () => {
    // `not: { type: 'null' }` accepts every object, but it is neither an
    // object-constraining branch nor a recognizable any-object one; ignoring
    // it would pin the other branch's constraints onto the root and reject
    // inputs the original accepts.
    const schema = {
      type: 'object',
      anyOf: [
        { not: { type: 'null' } },
        {
          properties: { a: { type: 'string', description: 'The a field.' } },
          required: ['a'],
          additionalProperties: false,
        },
      ],
    };

    const result = normalizeKimiToolSchema(schema);

    expect(structureOf(schema)).toEqual({ type: 'object', properties: {} });
    expect(result['description']).toBe(
      'Fields without their own schema entry:\n- a — The a field.',
    );
  });

  it('reports the unrestricted variant of an exclusive union', () => {
    // A `{}` member of a oneOf does not make the union accept every object —
    // it makes every other variant invalid. Widening is still the only
    // representable option, so the structure is spelled out instead.
    const schema = {
      type: 'object',
      oneOf: [{}, { required: ['mode'] }],
    };

    const result = normalizeKimiToolSchema(schema);

    expect(structureOf(schema)).toEqual({ type: 'object', properties: {} });
    expect(result['description']).toBe(
      [
        'Valid argument variants (exactly one must match): (1) any object. (2) required: mode.',
        'Fields without their own schema entry:\n- mode',
      ].join('\n\n'),
    );
  });

  it('merges conflicting branch property schemas into a nested union', () => {
    const schema = {
      type: 'object',
      anyOf: [
        { properties: { value: { type: 'string' } }, required: ['value'] },
        { properties: { value: { type: 'number' } }, required: ['value'] },
      ],
    };

    const result = structureOf(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
      required: ['value'],
    });
  });

  it('omits a property constraint that an open branch leaves unconstrained', () => {
    const schema = {
      type: 'object',
      anyOf: [
        {
          properties: { a: { type: 'string' } },
          required: ['a'],
          additionalProperties: false,
        },
        {
          properties: { b: { type: 'string' } },
          required: ['b'],
        },
      ],
    };

    const result = structureOf(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        b: { type: 'string' },
      },
    });
  });

  it('repairs type next to a combinator on nested property schemas', () => {
    const schema = {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          anyOf: [{ enum: ['fast'] }, { enum: ['safe'] }],
        },
        window: {
          type: 'integer',
          oneOf: [{ minimum: 1 }, { maximum: -1 }],
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        mode: {
          anyOf: [
            { enum: ['fast'], type: 'string' },
            { enum: ['safe'], type: 'string' },
          ],
        },
        window: {
          oneOf: [
            { minimum: 1, type: 'integer' },
            { maximum: -1, type: 'integer' },
          ],
        },
      },
    });
  });

  it('copies a nested type array verbatim into typeless combinator branches', () => {
    const schema = {
      type: 'object',
      properties: {
        x: {
          type: ['object', 'null'],
          anyOf: [{ properties: { a: { type: 'string' } } }],
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        x: {
          anyOf: [{ properties: { a: { type: 'string' } }, type: ['object', 'null'] }],
        },
      },
    });
  });

  it('pushes the parent type into nested branches and removes dead ones', () => {
    const schema = {
      type: 'object',
      properties: {
        x: {
          type: 'object',
          anyOf: [{ type: 'string' }, { not: { const: null } }],
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        x: {
          anyOf: [{ not: { const: null, type: 'null' }, type: 'object' }],
        },
      },
    });
  });

  it('narrows a nested branch type to its intersection with the parent type', () => {
    const schema = {
      type: 'object',
      properties: {
        x: {
          type: ['string', 'integer'],
          anyOf: [{ type: ['integer', 'boolean'] }, { type: 'number' }, { minLength: 2 }],
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        x: {
          anyOf: [
            { type: 'integer' },
            { type: 'integer' },
            { minLength: 2, type: ['string', 'integer'] },
          ],
        },
      },
    });
  });

  it('replaces nested boolean true branches with the parent type constraint', () => {
    const schema = {
      type: 'object',
      properties: {
        x: {
          type: 'object',
          anyOf: [true, { properties: { a: { type: 'string' } } }],
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        x: {
          anyOf: [{ type: 'object' }, { properties: { a: { type: 'string' } }, type: 'object' }],
        },
      },
    });
  });

  it('intersects an inherited nested type with enum inference instead of overwriting it', () => {
    const schema = {
      type: 'object',
      properties: {
        x: {
          type: ['string', 'integer'],
          anyOf: [{ enum: ['x'] }],
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        x: {
          anyOf: [{ enum: ['x'], type: 'string' }],
        },
      },
    });
  });

  it('removes a nested branch whose enum values conflict with the inherited type', () => {
    const schema = {
      type: 'object',
      properties: {
        x: {
          type: 'object',
          anyOf: [{ enum: ['x'] }, { properties: { a: { type: 'string' } } }],
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        x: {
          anyOf: [{ properties: { a: { type: 'string' } }, type: 'object' }],
        },
      },
    });
  });

  it('kills a nested const branch whose value does not satisfy the inherited type', () => {
    const schema = {
      type: 'object',
      properties: {
        x: {
          type: 'integer',
          anyOf: [{ const: 1.5 }],
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        x: {
          type: 'integer',
        },
      },
    });
  });

  it('keeps a nested const branch whose value satisfies the inherited type', () => {
    const schema = {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          anyOf: [{ const: 2 }],
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        x: {
          anyOf: [{ const: 2, type: 'integer' }],
        },
      },
    });
  });

  it('filters nested enum members by the inherited type instead of widening it', () => {
    const schema = {
      type: 'object',
      properties: {
        x: {
          type: 'integer',
          anyOf: [{ enum: [1, 1.5] }],
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        x: {
          anyOf: [{ enum: [1], type: 'integer' }],
        },
      },
    });
  });
});
