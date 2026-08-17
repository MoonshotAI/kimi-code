import { derefJsonSchema, normalizeKimiToolSchema } from '#/providers/kimi-schema';
import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';

describe('derefJsonSchema', () => {
  it('returns schema unchanged when there are no $ref', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    };

    const result = derefJsonSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    });
  });

  it('resolves a simple $ref from $defs', () => {
    const schema = {
      type: 'object',
      properties: {
        address: { $ref: '#/$defs/Address' },
      },
      $defs: {
        Address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
          },
        },
      },
    };

    const result = derefJsonSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
          },
        },
      },
    });
    // $defs should be removed from the result.
    expect(result['$defs']).toBeUndefined();
  });

  it('preserves sibling keywords alongside $ref (e.g. description)', () => {
    const schema = {
      type: 'object',
      properties: {
        user: {
          $ref: '#/$defs/User',
          description: 'Custom description on the ref site',
        },
      },
      $defs: {
        User: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
        },
      },
    };

    const result = derefJsonSchema(schema);

    const user = (result['properties'] as Record<string, Record<string, unknown>>)['user']!;
    // Resolved definition fields are present.
    expect(user['type']).toBe('object');
    expect(user['properties']).toEqual({ name: { type: 'string' } });
    // Local sibling "description" is preserved.
    expect(user['description']).toBe('Custom description on the ref site');
  });

  it('local sibling fields override same-named fields from $defs', () => {
    const schema = {
      type: 'object',
      properties: {
        field: {
          $ref: '#/$defs/Widget',
          // Local override must win over the def's description.
          description: 'local override wins',
        },
      },
      $defs: {
        Widget: {
          type: 'string',
          description: 'description from $defs',
          default: 'hello',
        },
      },
    };

    const result = derefJsonSchema(schema);

    const field = (result['properties'] as Record<string, Record<string, unknown>>)['field']!;
    expect(field['type']).toBe('string');
    // Local sibling wins.
    expect(field['description']).toBe('local override wins');
    // Non-overlapping def fields still flow through.
    expect(field['default']).toBe('hello');
  });

  it('preserves sibling $ref keywords that themselves contain $ref (recursively resolved)', () => {
    const schema = {
      type: 'object',
      properties: {
        entry: {
          $ref: '#/$defs/Wrapper',
          extra: { $ref: '#/$defs/Inner' },
        },
      },
      $defs: {
        Wrapper: {
          type: 'object',
          properties: { a: { type: 'number' } },
        },
        Inner: {
          type: 'object',
          properties: { b: { type: 'boolean' } },
        },
      },
    };

    const result = derefJsonSchema(schema);

    const entry = (result['properties'] as Record<string, Record<string, unknown>>)['entry']!;
    expect(entry['type']).toBe('object');
    expect(entry['properties']).toEqual({ a: { type: 'number' } });
    // Sibling `extra` must have been recursively resolved (not left as a $ref).
    expect(entry['extra']).toEqual({
      type: 'object',
      properties: { b: { type: 'boolean' } },
    });
  });

  it('preserves $defs when cyclic refs remain unresolved', () => {
    // A references B, B references A — classic cycle. resolveNode() leaves
    // a `#/$defs/...` pointer on at least one side; the validator will need
    // $defs to stay around to resolve those dangling pointers.
    const schema = {
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/A' },
      },
      $defs: {
        A: {
          type: 'object',
          properties: {
            next: { $ref: '#/$defs/B' },
          },
        },
        B: {
          type: 'object',
          properties: {
            back: { $ref: '#/$defs/A' },
          },
        },
      },
    };

    const result = derefJsonSchema(schema);

    expect(result).toMatchObject({
      $defs: {
        A: expect.any(Object),
        B: expect.any(Object),
      },
    });

    // Walk the result and confirm at least one remaining $ref points at $defs —
    // i.e. the output is internally consistent, not dangling.
    const jsonText = JSON.stringify(result);
    expect(jsonText).toContain('"$ref":"#/$defs/');
  });

  it('still deletes $defs when there are no cyclic refs', () => {
    // Sanity: a non-cyclic schema with $defs should have its $defs removed
    // after dereferencing (existing behavior must not regress).
    const schema = {
      type: 'object',
      properties: {
        name: { $ref: '#/$defs/Name' },
      },
      $defs: {
        Name: { type: 'string' },
      },
    };

    const result = derefJsonSchema(schema);
    expect(result['$defs']).toBeUndefined();
    expect(result['properties']).toEqual({ name: { type: 'string' } });
  });

  it('resolves nested $ref from $defs', () => {
    const schema = {
      type: 'object',
      properties: {
        person: { $ref: '#/$defs/Person' },
      },
      $defs: {
        Person: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            address: { $ref: '#/$defs/Address' },
          },
        },
        Address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
          },
        },
      },
    };

    const result = derefJsonSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        person: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            address: {
              type: 'object',
              properties: {
                street: { type: 'string' },
                city: { type: 'string' },
              },
            },
          },
        },
      },
    });
    expect(result['$defs']).toBeUndefined();
  });

  it('resolves a local $ref from draft-7 definitions', () => {
    const schema = {
      type: 'object',
      properties: {
        mode: { $ref: '#/definitions/Mode' },
      },
      definitions: {
        Mode: { enum: ['fast', 'safe'] },
      },
    };

    const result = derefJsonSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        mode: { enum: ['fast', 'safe'] },
      },
    });
    expect(result['definitions']).toBeUndefined();
  });
});

/**
 * Structure-only view: the variant summary appended to `description` has its
 * own tests, so structural assertions below drop it.
 */
function structureOf(schema: Record<string, unknown>): Record<string, unknown> {
  const { description: _description, ...rest } = normalizeKimiToolSchema(schema);
  return rest;
}

describe('normalizeKimiToolSchema', () => {
  it.each([
    {
      name: 'string enum',
      property: { enum: ['none', 'start', 'end'] },
      expectedType: 'string',
    },
    {
      name: 'integer enum',
      property: { enum: [1, 2, 3] },
      expectedType: 'integer',
    },
    {
      name: 'mixed integer and float enum collapses to number',
      property: { enum: [1.5, 2] },
      expectedType: 'number',
    },
    {
      name: 'boolean enum',
      property: { enum: [true, false] },
      expectedType: 'boolean',
    },
    {
      name: 'single boolean enum',
      property: { enum: [true] },
      expectedType: 'boolean',
    },
    {
      name: 'null-only enum',
      property: { enum: [null] },
      expectedType: 'null',
    },
    {
      name: 'string const',
      property: { const: 'event' },
      expectedType: 'string',
    },
    {
      name: 'integer const',
      property: { const: 3 },
      expectedType: 'integer',
    },
    {
      name: 'number const',
      property: { const: 1.25 },
      expectedType: 'number',
    },
    {
      name: 'boolean const',
      property: { const: true },
      expectedType: 'boolean',
    },
  ])(
    'infers $name property type without mutating the original schema',
    ({ property, expectedType }) => {
      const schema = {
        type: 'object',
        properties: {
          target: property,
        },
      };
      const original = structuredClone(schema);

      const result = normalizeKimiToolSchema(schema);

      expect(result).toEqual({
        type: 'object',
        properties: {
          target: { ...property, type: expectedType },
        },
      });
      expect(schema).toEqual(original);
      expect(result).not.toBe(schema);
    },
  );

  it('leaves explicitly typed enum properties untouched', () => {
    const schema = {
      type: 'object',
      properties: {
        explicit: { type: 'string', enum: ['already-typed'] },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        explicit: { type: 'string', enum: ['already-typed'] },
      },
    });
  });

  it('repairs mismatched explicit type when enum values contradict it', () => {
    // Regression: Xcode MCP (xcrun mcpbridge) Version 26.5 (17F42) and later
    // generates schemas where String-backed Swift enums incorrectly carry
    // type: 'object' alongside string enum values. We overwrite the contradictory
    // type and strip object/array structure keys that are no longer relevant.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: {
        operation: {
          type: 'object',
          enum: ['move', 'copy'],
          properties: {
            rawValue: { type: 'string' },
          },
          required: ['rawValue'],
        },
      },
    };

    try {
      const result = normalizeKimiToolSchema(schema);

      expect(result).toEqual({
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['move', 'copy'],
          },
        },
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('repairs mismatched explicit type when const value contradicts it', () => {
    const schema = {
      type: 'object',
      properties: {
        mode: { type: 'object', const: 'fast' },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        mode: { type: 'string', const: 'fast' },
      },
    });
  });

  it('leaves mixed enum types with explicit type untouched to surface provider error', () => {
    const schema = {
      type: 'object',
      properties: {
        bad: { type: 'object', enum: ['move', 1] },
      },
    };

    // inferTypeFromValues throws for mixed types; we should not overwrite the
    // explicit type so the downstream provider validator can report the issue.
    expect(() => normalizeKimiToolSchema(schema)).not.toThrow();
    const result = normalizeKimiToolSchema(schema);
    expect(result).toEqual({
      type: 'object',
      properties: {
        bad: { type: 'object', enum: ['move', 1] },
      },
    });
  });

  it('infers object and array property types from container enum/const values', () => {
    const schema = {
      type: 'object',
      properties: {
        object_enum: { enum: [{ a: 1 }, { a: 2 }] },
        array_enum: { enum: [[1, 2], [3]] },
        object_const: { const: { kind: 'default' } },
        array_const: { const: [] },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        object_enum: { enum: [{ a: 1 }, { a: 2 }], type: 'object' },
        array_enum: { enum: [[1, 2], [3]], type: 'array' },
        object_const: { const: { kind: 'default' }, type: 'object' },
        array_const: { const: [], type: 'array' },
      },
    });
  });

  it('fails fast for mixed enum types instead of emitting an unsupported Kimi type array', () => {
    const schema = {
      type: 'object',
      properties: {
        mixedEnum: { enum: ['auto', 1] },
      },
    };
    const original = structuredClone(schema);

    expect(() => normalizeKimiToolSchema(schema)).toThrow(
      /Mixed JSON Schema enum or const types are not supported/,
    );
    expect(schema).toEqual(original);
  });

  it('infers object and array structure recursively', () => {
    const schema = {
      properties: {
        filters: {
          properties: {
            language: { enum: ['typescript', 'python'] },
            tags: {
              items: { enum: ['bug', 'feature'] },
            },
          },
          required: ['language'],
        },
        edits: {
          items: {
            properties: {
              path: { const: 'src/index.ts' },
              lineNumbers: {
                items: { const: 42 },
              },
            },
          },
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      properties: {
        filters: {
          type: 'object',
          properties: {
            language: { enum: ['typescript', 'python'], type: 'string' },
            tags: {
              type: 'array',
              items: { enum: ['bug', 'feature'], type: 'string' },
            },
          },
          required: ['language'],
        },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { const: 'src/index.ts', type: 'string' },
              lineNumbers: {
                type: 'array',
                items: { const: 42, type: 'integer' },
              },
            },
          },
        },
      },
    });
  });

  it('uses structural hints before falling back to string on nested typeless schemas', () => {
    const schema = {
      properties: {
        path: { pattern: '^src/' },
        limit: { minimum: 1 },
        freeform: { description: 'Unconstrained external MCP field.' },
        empty: {},
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      properties: {
        path: { pattern: '^src/', type: 'string' },
        limit: { minimum: 1, type: 'number' },
        freeform: { description: 'Unconstrained external MCP field.', type: 'string' },
        empty: { type: 'string' },
      },
    });
  });

  it('does not default the root schema itself to string', () => {
    expect(normalizeKimiToolSchema({})).toEqual({});
  });

  it('dereferences and normalizes local definition buckets', () => {
    const schema = {
      type: 'object',
      properties: {
        mode: { $ref: '#/$defs/Mode' },
        retryCount: { $ref: '#/definitions/RetryCount' },
      },
      $defs: {
        Mode: { enum: ['fast', 'safe'] },
      },
      definitions: {
        RetryCount: { const: 3 },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        mode: { enum: ['fast', 'safe'], type: 'string' },
        retryCount: { const: 3, type: 'integer' },
      },
    });
  });

  it('normalizes nested child schema positions', () => {
    const thenKeyword = ['th', 'en'].join('');
    const schema = {
      properties: {
        labels: {
          patternProperties: {
            '^x-': { enum: ['yes', 'no'] },
          },
          propertyNames: { pattern: '^x-' },
          additionalProperties: { const: false },
        },
        tuple: {
          prefixItems: [{ enum: ['left', 'right'] }, { const: 2 }],
          contains: { enum: ['needle'] },
        },
        conditional: {
          if: { properties: { kind: { const: 'file' } } },
          [thenKeyword]: { properties: { path: { pattern: '^src/' } } },
          else: { properties: { url: { format: 'uri' } } },
          not: { properties: { blocked: { const: true } } },
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      properties: {
        labels: {
          type: 'object',
          patternProperties: {
            '^x-': { enum: ['yes', 'no'], type: 'string' },
          },
          propertyNames: { pattern: '^x-', type: 'string' },
          additionalProperties: { const: false, type: 'boolean' },
        },
        tuple: {
          type: 'array',
          prefixItems: [
            { enum: ['left', 'right'], type: 'string' },
            { const: 2, type: 'integer' },
          ],
          contains: { enum: ['needle'], type: 'string' },
        },
        conditional: {
          if: {
            type: 'object',
            properties: { kind: { const: 'file', type: 'string' } },
          },
          [thenKeyword]: {
            type: 'object',
            properties: { path: { pattern: '^src/', type: 'string' } },
          },
          else: {
            type: 'object',
            properties: { url: { format: 'uri', type: 'string' } },
          },
          not: {
            type: 'object',
            properties: { blocked: { const: true, type: 'boolean' } },
          },
        },
      },
    });
  });

  it('infers parent types from every walked child-schema keyword', () => {
    const schema = {
      properties: {
        dependentSchemasOnly: {
          dependentSchemas: {
            kind: {
              properties: {
                value: { enum: ['file', 'url'] },
              },
            },
          },
        },
        dependenciesOnly: {
          dependencies: {
            kind: {
              properties: {
                enabled: { const: true },
              },
            },
          },
        },
        unevaluatedPropertiesOnly: {
          unevaluatedProperties: { enum: ['allowed'] },
        },
        additionalItemsOnly: {
          additionalItems: { const: 1 },
        },
        unevaluatedItemsOnly: {
          unevaluatedItems: { const: 2 },
        },
        contentSchemaOnly: {
          contentSchema: {
            properties: {
              decoded: { enum: ['payload'] },
            },
          },
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      properties: {
        dependentSchemasOnly: {
          type: 'object',
          dependentSchemas: {
            kind: {
              type: 'object',
              properties: {
                value: { enum: ['file', 'url'], type: 'string' },
              },
            },
          },
        },
        dependenciesOnly: {
          type: 'object',
          dependencies: {
            kind: {
              type: 'object',
              properties: {
                enabled: { const: true, type: 'boolean' },
              },
            },
          },
        },
        unevaluatedPropertiesOnly: {
          type: 'object',
          unevaluatedProperties: { enum: ['allowed'], type: 'string' },
        },
        additionalItemsOnly: {
          type: 'array',
          additionalItems: { const: 1, type: 'integer' },
        },
        unevaluatedItemsOnly: {
          type: 'array',
          unevaluatedItems: { const: 2, type: 'integer' },
        },
        contentSchemaOnly: {
          type: 'string',
          contentSchema: {
            type: 'object',
            properties: {
              decoded: { enum: ['payload'], type: 'string' },
            },
          },
        },
      },
    });
  });

  it('preserves nested combinators while normalizing their schema branches', () => {
    const schema = {
      type: 'object',
      properties: {
        pick: {
          anyOf: [{ enum: ['auto', 'manual'] }, { const: false }],
          oneOf: [
            {
              properties: {
                strategy: { enum: ['replace', 'insert'] },
              },
            },
          ],
          allOf: [
            {
              items: { const: 1 },
            },
          ],
        },
      },
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        pick: {
          anyOf: [
            { enum: ['auto', 'manual'], type: 'string' },
            { const: false, type: 'boolean' },
          ],
          oneOf: [
            {
              type: 'object',
              properties: {
                strategy: { enum: ['replace', 'insert'], type: 'string' },
              },
            },
          ],
          allOf: [
            {
              type: 'array',
              items: { const: 1, type: 'integer' },
            },
          ],
        },
      },
    });
  });

  it('flattens a root union into a single typed object root', () => {
    // Regression: an MCP server published a tool whose root schema declared
    // both `type: 'object'` and a three-way `anyOf`. Moonshot rejects `type`
    // next to `anyOf` AND requires the parameters root to carry
    // `type: "object"`, so a root union is unrepresentable on the wire:
    // object branches merge into the root — properties first-wins, `required`
    // keeps only fields every branch requires, and the exactly-one-of intent
    // stays in the description (the MCP server still enforces it).
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
            filename: { type: 'string', minLength: 1 },
            source_url: { type: 'string', minLength: 1 },
          },
          required: ['filename', 'source_url'],
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
      // The variant structure is unrepresentable on the wire, so it is
      // restated in the description — otherwise the model only sees a bag of
      // merged properties.
      description: [
        'Provide exactly one of the documented input variants.',
        'Valid argument variants (at least one must match): ' +
          '(1) required: filename, content. ' +
          '(2) required: filename, source_url. ' +
          '(3) required: source_id.',
      ].join('\n\n'),
      properties: {
        filename: { type: 'string', minLength: 1 },
        content: { type: 'string', maxLength: 1024 },
        source_url: { type: 'string', minLength: 1 },
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

  it('leaves the root own property schemas to the type-completion pass', () => {
    // Flattening does not change what completion does to the root's own
    // properties: a typeless schema is still completed to `string` exactly as
    // it would be without a union. The superset guarantee is about the
    // flattening step, not about this long-standing completion behavior.
    const schema = {
      type: 'object',
      properties: { value: { description: 'Any JSON value' } },
      anyOf: [{ required: ['value'] }],
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: { value: { description: 'Any JSON value', type: 'string' } },
      required: ['value'],
    });
    expect(normalizeKimiToolSchema({ type: 'object', properties: schema.properties })).toEqual({
      type: 'object',
      properties: { value: { description: 'Any JSON value', type: 'string' } },
    });
  });

  it('names fields that lost their schema entry in the variant summary', () => {
    // An open branch forces `source_url` out of `properties` (constraining it
    // would narrow), so its name and description survive only in the summary.
    const schema = {
      type: 'object',
      anyOf: [
        {
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: {},
        },
        {
          properties: {
            source_url: { type: 'string', description: 'A publicly reachable HTTPS URL.' },
          },
          required: ['source_url'],
          additionalProperties: false,
        },
      ],
    };

    const result = normalizeKimiToolSchema(schema);

    // `text` is only constrained by the closed branch, so it survives;
    // `source_url` cannot be constrained without narrowing the open branch.
    expect(result['properties']).toEqual({ text: { type: 'string' } });
    expect(result['description']).toBe(
      [
        'Valid argument variants (at least one must match): ' +
          '(1) required: text. (2) required: source_url.',
        'Fields without their own schema entry:\n' +
          '- source_url — A publicly reachable HTTPS URL.',
      ].join('\n\n'),
    );
  });

  it('reports an exclusive union as exactly one variant', () => {
    const schema = {
      type: 'object',
      oneOf: [
        { properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
        { properties: { b: { type: 'string' } }, required: ['b'], additionalProperties: false },
      ],
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result['description']).toBe(
      'Valid argument variants (exactly one must match): (1) required: a. (2) required: b.',
    );
  });

  it('lists optional branch fields alongside the required ones', () => {
    const schema = {
      type: 'object',
      anyOf: [
        {
          properties: { a: { type: 'string' }, note: { type: 'string' } },
          required: ['a'],
          additionalProperties: false,
        },
        {
          properties: { b: { type: 'string' } },
          required: ['b'],
          additionalProperties: false,
        },
      ],
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result['description']).toBe(
      'Valid argument variants (at least one must match): ' +
        '(1) required: a; optional: note. (2) required: b.',
    );
  });

  it('adds no variant summary when a single branch carries the whole union', () => {
    const schema = {
      type: 'object',
      properties: { value: { type: 'string' } },
      anyOf: [{ required: ['value'] }],
    };

    const result = normalizeKimiToolSchema(schema);

    expect(result).not.toHaveProperty('description');
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
    // A first-wins merge would keep only the string variant and reject
    // `{ value: 1 }`, which the original schema accepts — the flattened root
    // must stay a superset of the original object inputs.
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
    // The second branch has no `additionalProperties` bound, so it accepts
    // any value for `a`; pinning `a` to the first branch's schema at the
    // root would reject inputs the original schema allows.
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
    // Original semantics of x: object AND (string OR not-null) — only objects
    // match (the string branch is unsatisfiable). The parent constraint must
    // survive on every remaining branch, not silently widen.
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
    // The enum/const type repair must not widen a branch beyond the parent
    // constraint it inherited: the inherited type participates in the
    // intersection rather than being replaced by the inferred value type.
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
    // object AND enum-of-strings matches nothing — the branch is dead and
    // must not come back as a plain string enum.
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
    // integer AND const 1.5 matches nothing; symmetric type algebra would
    // keep the branch as `number` and start accepting 1.5. A union with no
    // live branch is dropped, relaxing to the parent constraint — neither
    // `anyOf: []` nor a boolean branch is accepted on the wire.
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

describe('flattened roots stay a superset of the original object inputs', () => {
  // Differential check: any object the original schema accepts must still be
  // accepted by the normalized schema — the wire schema may only widen, the
  // MCP server performs the final validation. Scope: the flattening step.
  // The root's own property schemas keep whatever the type-completion pass
  // does to them, union or not (see the test above), so these fixtures state
  // branch-local constraints rather than relying on typeless root properties.
  const cases: { name: string; schema: Record<string, unknown>; samples: unknown[] }[] = [
    {
      name: 'conflicting property variants',
      schema: {
        type: 'object',
        anyOf: [
          { properties: { value: { type: 'string' } }, required: ['value'] },
          { properties: { value: { type: 'number' } }, required: ['value'] },
        ],
      },
      samples: [{ value: 'x' }, { value: 1 }, { value: true }, {}],
    },
    {
      name: 'exactly-one-of tool variants with closed branches',
      schema: {
        type: 'object',
        anyOf: [
          {
            type: 'object',
            properties: {
              filename: { type: 'string', minLength: 1 },
              content: { type: 'string' },
            },
            required: ['filename', 'content'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              filename: { type: 'string', minLength: 1 },
              source_url: { type: 'string' },
            },
            required: ['filename', 'source_url'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { source_id: { type: 'string' } },
            required: ['source_id'],
            additionalProperties: false,
          },
        ],
      },
      samples: [
        { filename: 'a.txt', content: 'x' },
        { filename: 'a.txt', source_url: 'https://example.com/f' },
        { source_id: '123' },
        { filename: 'a.txt' },
        {},
      ],
    },
    {
      name: 'open branch accepting extra keys',
      schema: {
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
      },
      samples: [{ a: 'x' }, { b: 'y' }, { b: 'y', a: 123 }, { a: 123 }],
    },
    {
      name: 'patternProperties branch allowing the same key',
      schema: {
        type: 'object',
        anyOf: [
          { properties: { value: { type: 'string' } }, additionalProperties: false },
          { patternProperties: { '^value$': { type: 'number' } }, additionalProperties: false },
        ],
      },
      samples: [{ value: 'x' }, { value: 1 }, { value: true }],
    },
    {
      name: 'typeless branch property accepting any JSON value',
      schema: {
        type: 'object',
        anyOf: [
          { properties: { value: { type: 'string' } }, additionalProperties: false },
          { properties: { value: { description: 'Any JSON value' } }, additionalProperties: false },
        ],
      },
      samples: [{ value: 'x' }, { value: 1 }, { value: { nested: true } }],
    },
    {
      name: 'required entries for an omitted property',
      schema: {
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
      },
      samples: [{ value: 'x' }, { value: 1 }, {}],
    },
    {
      name: 'branch accepting any object',
      schema: {
        type: 'object',
        anyOf: [{}, { properties: { b: { type: 'number' } }, required: ['b'] }],
      },
      samples: [{}, { b: 1 }, { b: 'x' }, { other: true }],
    },
    {
      name: 'opaque branch accepting every object',
      schema: {
        type: 'object',
        anyOf: [
          { not: { type: 'null' } },
          { properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
        ],
      },
      samples: [{}, { a: 'x' }, { a: 123 }, { other: true }],
    },
    {
      name: 'exclusive union with an unrestricted member',
      schema: {
        type: 'object',
        oneOf: [{}, { properties: { a: { type: 'string' } }, required: ['a'] }],
      },
      samples: [{}, { a: 123 }, { other: 1 }],
    },
    {
      name: 'required variants over shared root properties',
      schema: {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        anyOf: [{ required: ['a'] }, { required: ['b'] }],
      },
      samples: [{ a: 'x' }, { b: 'y' }, { a: 1 }, {}],
    },
  ];

  for (const { name, schema, samples } of cases) {
    it(`accepts every originally-valid object: ${name}`, () => {
      const ajv = new Ajv({ strict: false });
      const original = ajv.compile(schema);
      const normalized = ajv.compile(normalizeKimiToolSchema(schema));
      for (const sample of samples) {
        if (original(sample)) {
          expect(normalized(sample), `sample ${JSON.stringify(sample)}`).toBe(true);
        }
      }
    });
  }
});
