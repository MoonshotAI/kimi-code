/**
 * Tests for `defineRoute` single-source-of-truth route declaration helper.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineRoute } from '../src/middleware/defineRoute.js';

describe('defineRoute', () => {
  // -------------------------------------------------------------------------
  // Path conversion
  // -------------------------------------------------------------------------
  it('converts OpenAPI {param} syntax to Fastify :param syntax', () => {
    const route = defineRoute(
      {
        method: 'GET',
        path: '/sessions/{session_id}/prompts/{prompt_id}',
        success: { data: z.object({ ok: z.boolean() }) },
      },
      async (_req, _reply) => {},
    );

    expect(route.path).toBe('/sessions/:session_id/prompts/:prompt_id');
  });

  it('leaves literal path segments unchanged', () => {
    const route = defineRoute(
      {
        method: 'GET',
        path: '/healthz',
        success: { data: z.object({ ok: z.boolean() }) },
      },
      async (_req, _reply) => {},
    );

    expect(route.path).toBe('/healthz');
  });

  // -------------------------------------------------------------------------
  // PreHandler generation
  // -------------------------------------------------------------------------
  it('builds preHandler from body + params + querystring schemas', () => {
    const bodySchema = z.object({ name: z.string() });
    const paramsSchema = z.object({ id: z.string() });
    const querySchema = z.object({ page: z.string() });

    const route = defineRoute(
      {
        method: 'POST',
        path: '/items/{id}',
        body: bodySchema,
        params: paramsSchema,
        querystring: querySchema,
        success: { data: z.object({ created: z.boolean() }) },
      },
      async (_req, _reply) => {},
    );

    expect(route.options.preHandler).toHaveLength(3);
  });

  it('omits preHandler when no schemas are provided', () => {
    const route = defineRoute(
      {
        method: 'GET',
        path: '/healthz',
        success: { data: z.object({ ok: z.boolean() }) },
      },
      async (_req, _reply) => {},
    );

    expect(route.options.preHandler).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Swagger schema generation
  // -------------------------------------------------------------------------
  it('includes body/params/querystring schemas in the route schema', () => {
    const bodySchema = z.object({ name: z.string() });
    const paramsSchema = z.object({ id: z.string() });
    const querySchema = z.object({ page: z.string() });

    const route = defineRoute(
      {
        method: 'POST',
        path: '/items/{id}',
        body: bodySchema,
        params: paramsSchema,
        querystring: querySchema,
        success: { data: z.object({ created: z.boolean() }) },
      },
      async (_req, _reply) => {},
    );

    const s = route.options.schema;
    expect(s['body']).toBeDefined();
    expect(s['params']).toBeDefined();
    expect(s['querystring']).toBeDefined();
  });

  it('carries metadata fields (description, tags, operationId, summary)', () => {
    const route = defineRoute(
      {
        method: 'GET',
        path: '/meta',
        success: { data: z.object({ version: z.string() }) },
        description: 'Get metadata',
        summary: 'Metadata',
        tags: ['meta'],
        operationId: 'getMeta',
      },
      async (_req, _reply) => {},
    );

    const s = route.options.schema;
    expect(s['description']).toBe('Get metadata');
    expect(s['summary']).toBe('Metadata');
    expect(s['tags']).toEqual(['meta']);
    expect(s['operationId']).toBe('getMeta');
  });

  // -------------------------------------------------------------------------
  // 200-response oneOf
  // -------------------------------------------------------------------------
  it('produces a 200 response with oneOf containing success + errors', () => {
    const route = defineRoute(
      {
        method: 'POST',
        path: '/items',
        body: z.object({ name: z.string() }),
        success: { data: z.object({ id: z.string() }) },
        errors: {
          40001: { detailsSchema: z.array(z.object({ path: z.string(), message: z.string() })) },
          40401: {},
        },
      },
      async (_req, _reply) => {},
    );

    const response = route.options.schema['response'] as Record<string, unknown>;
    expect(response).toBeDefined();

    const status200 = response['200'] as Record<string, unknown>;
    expect(status200).toBeDefined();
    expect(Array.isArray(status200['oneOf'])).toBe(true);
    expect((status200['oneOf'] as unknown[])).toHaveLength(3); // success + 2 errors
  });

  it('places the success variant first in the oneOf array', () => {
    const route = defineRoute(
      {
        method: 'POST',
        path: '/items',
        success: { data: z.object({ id: z.string() }) },
        errors: {
          40401: {},
        },
      },
      async (_req, _reply) => {},
    );

    const oneOf = (route.options.schema['response'] as Record<string, unknown>)['200'] as Record<string, unknown>;
    const variants = oneOf['oneOf'] as Array<Record<string, unknown>>;
    const first = variants[0]!;
    const props = first['properties'] as Record<string, unknown>;
    const codeProp = props['code'] as Record<string, unknown>;
    expect((codeProp['enum'] as unknown[])[0]).toBe(0);
  });

  it('sorts error variants by code in ascending order', () => {
    const route = defineRoute(
      {
        method: 'POST',
        path: '/items',
        success: { data: z.object({ id: z.string() }) },
        errors: {
          40901: {},
          40001: {},
          40401: {},
        },
      },
      async (_req, _reply) => {},
    );

    const oneOf = ((route.options.schema['response'] as Record<string, unknown>)['200'] as Record<string, unknown>)['oneOf'] as Array<Record<string, unknown>>;
    // [success, 40001, 40401, 40901]
    expect(oneOf).toHaveLength(4);
    const codes = oneOf.slice(1).map((v) => {
      const props = v['properties'] as Record<string, unknown>;
      return ((props['code'] as Record<string, unknown>)['enum'] as unknown[])[0];
    });
    expect(codes).toEqual([40001, 40401, 40901]);
  });

  it('includes details schema in error variants when provided', () => {
    const route = defineRoute(
      {
        method: 'POST',
        path: '/items',
        success: { data: z.object({ id: z.string() }) },
        errors: {
          40111: { detailsSchema: z.object({ provider_id: z.string() }) },
        },
      },
      async (_req, _reply) => {},
    );

    const oneOf = ((route.options.schema['response'] as Record<string, unknown>)['200'] as Record<string, unknown>)['oneOf'] as Array<Record<string, unknown>>;
    const errVariant = oneOf[1]!;
    const props = errVariant['properties'] as Record<string, unknown>;
    const details = props['details'] as Record<string, unknown>;
    expect(details).toBeDefined();
    // details should be nullable object because of .nullable().optional()
    expect(details['nullable']).toBe(true);
    expect(details['type']).toBe('object');
  });

  it('uses unknown-optional details when error has no detailsSchema', () => {
    const route = defineRoute(
      {
        method: 'POST',
        path: '/items',
        success: { data: z.object({ id: z.string() }) },
        errors: {
          40401: {},
        },
      },
      async (_req, _reply) => {},
    );

    const oneOf = ((route.options.schema['response'] as Record<string, unknown>)['200'] as Record<string, unknown>)['oneOf'] as Array<Record<string, unknown>>;
    const errVariant = oneOf[1]!;
    const props = errVariant['properties'] as Record<string, unknown>;
    const details = props['details'] as Record<string, unknown>;
    expect(details).toBeDefined();
    // z.unknown().optional() → {}
    expect(Object.keys(details)).toHaveLength(0);
  });

  it('returns a plain envelope schema when errors is omitted', () => {
    const route = defineRoute(
      {
        method: 'GET',
        path: '/healthz',
        success: { data: z.object({ ok: z.boolean() }) },
      },
      async (_req, _reply) => {},
    );

    const status200 = (route.options.schema['response'] as Record<string, unknown>)['200'] as Record<string, unknown>;
    // No errors → plain schema (not wrapped in oneOf)
    expect(status200['oneOf']).toBeUndefined();
    const props = status200['properties'] as Record<string, unknown>;
    expect(((props['code'] as Record<string, unknown>)['enum'] as unknown[])[0]).toBe(0);
  });

  it('uses custom dataSchema in error variants when provided', () => {
    const route = defineRoute(
      {
        method: 'POST',
        path: '/items',
        success: { data: z.object({ id: z.string() }) },
        errors: {
          40903: { dataSchema: z.object({ aborted: z.literal(false) }) },
        },
      },
      async (_req, _reply) => {},
    );

    const oneOf = ((route.options.schema['response'] as Record<string, unknown>)['200'] as Record<string, unknown>)['oneOf'] as Array<Record<string, unknown>>;
    const errVariant = oneOf[1]!;
    const props = errVariant['properties'] as Record<string, unknown>;
    const data = props['data'] as Record<string, unknown>;
    expect(data['type']).toBe('object');
    const dataProps = data['properties'] as Record<string, unknown>;
    expect(dataProps['aborted']).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Handler type inference (compile-time only — no runtime assertion needed)
  // -------------------------------------------------------------------------
  it('infers body/params/query types for the handler (compile-time)', () => {
    const bodySchema = z.object({ name: z.string() });
    const paramsSchema = z.object({ id: z.string() });
    const querySchema = z.object({ page: z.string() });

    defineRoute(
      {
        method: 'POST',
        path: '/items/{id}',
        body: bodySchema,
        params: paramsSchema,
        querystring: querySchema,
        success: { data: z.object({ created: z.boolean() }) },
      },
      async (req, _reply) => {
        // These should type-check without casts:
        const _name: string = req.body.name;
        const _id: string = req.params.id;
        const _page: string = req.query.page;

        // Suppress unused-variable warnings in the test body
        void _name;
        void _id;
        void _page;
      },
    );
  });
});
