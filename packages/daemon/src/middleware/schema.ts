/**
 * Zod → JSON Schema conversion helpers for Fastify `@fastify/swagger`.
 *
 * All daemon REST responses are wrapped in a uniform envelope
 * `{ code, msg, data, request_id }`. The helpers here let route modules
 * declare their OpenAPI schema by re-using the same Zod schemas that
 * already drive runtime validation — no second source of truth.
 */

import { envelopeSchema } from '@moonshot-ai/protocol';
import { z } from 'zod';

/**
 * Convert a Zod schema to a plain JSON Schema object suitable for
 * Fastify's `schema` option.
 *
 * We drop the top-level `$schema` key because Fastify/OpenAPI inline
 * schemas don't need it.
 */
export function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return jsonSchemaForTarget(schema, 'input', 'draft-7');
}

/**
 * Convert a Zod schema to a response-side Fastify JSON Schema object.
 */
export function outputJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return jsonSchemaForTarget(schema, 'output', 'draft-7');
}

/**
 * Convert a Zod schema directly to an OpenAPI 3 schema object.
 *
 * Fastify route schemas use draft-7 because Fastify validates/serializes with
 * AJV; `@fastify/swagger` converts those schemas to OpenAPI. Post-processing
 * hooks run after that conversion, so schemas inserted there must already use
 * OpenAPI 3 semantics.
 */
export function openApiDocumentJsonSchema(
  schema: z.ZodTypeAny,
  io: 'input' | 'output' = 'input',
): Record<string, unknown> {
  return jsonSchemaForTarget(schema, io, 'openapi-3.0');
}

function jsonSchemaForTarget(
  schema: z.ZodTypeAny,
  io: 'input' | 'output',
  target: 'draft-7' | 'openapi-3.0',
): Record<string, unknown> {
  const converted = z.toJSONSchema(schema, {
    target,
    io,
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  if (converted['$schema'] !== undefined) {
    delete converted['$schema'];
  }
  return converted;
}

/**
 * Wrap a data Zod schema in the daemon's envelope shape and return its
 * JSON Schema representation.
 */
export function envelopeJsonSchema(
  dataSchema: z.ZodTypeAny,
): Record<string, unknown> {
  return outputJsonSchema(envelopeSchema(dataSchema));
}

export function openApiDocumentEnvelopeJsonSchema(
  dataSchema: z.ZodTypeAny,
): Record<string, unknown> {
  return openApiDocumentJsonSchema(envelopeSchema(dataSchema), 'output');
}

/**
 * Build a Fastify route-schema bag from Zod schemas + metadata.
 *
 * All Zod fields are automatically converted via `jsonSchema()`.
 * The `response` map values are also wrapped in envelopes unless you
 * pass an explicit `rawResponse` option.
 */
export interface RouteSchemaOptions {
  /** Request body Zod schema. */
  body?: z.ZodTypeAny;
  /** Query-string Zod schema. */
  querystring?: z.ZodTypeAny;
  /** Route params Zod schema. */
  params?: z.ZodTypeAny;
  /**
   * Response schema map: status code → Zod schema.
   * Each schema is automatically wrapped in the envelope.
   * Use `rawResponse` if you need an unwrapped schema (e.g. binary
   * download success path).
   */
  response?: Record<number, z.ZodTypeAny>;
  /**
   * Response schema map that is NOT envelope-wrapped.
   * Useful for the `200` on binary-stream endpoints.
   */
  rawResponse?: Record<number, Record<string, unknown>>;
  description?: string;
  summary?: string;
  tags?: string[];
  operationId?: string;
  consumes?: string[];
  produces?: string[];
}

export function buildRouteSchema(options: RouteSchemaOptions): Record<string, unknown> {
  const schema: Record<string, unknown> = {};

  if (options.body) {
    schema['body'] = jsonSchema(options.body);
  }
  if (options.querystring) {
    schema['querystring'] = jsonSchema(options.querystring);
  }
  if (options.params) {
    schema['params'] = jsonSchema(options.params);
  }
  if (options.response || options.rawResponse) {
    const responses: Record<string, unknown> = {};
    if (options.response) {
      for (const [code, zodSchema] of Object.entries(options.response)) {
        responses[String(code)] = envelopeJsonSchema(zodSchema);
      }
    }
    if (options.rawResponse) {
      for (const [code, rawSchema] of Object.entries(options.rawResponse)) {
        responses[String(code)] = rawSchema;
      }
    }
    schema['response'] = responses;
  }
  if (options.description) {
    schema['description'] = options.description;
  }
  if (options.summary) {
    schema['summary'] = options.summary;
  }
  if (options.tags) {
    schema['tags'] = options.tags;
  }
  if (options.operationId) {
    schema['operationId'] = options.operationId;
  }
  if (options.consumes) {
    schema['consumes'] = options.consumes;
  }
  if (options.produces) {
    schema['produces'] = options.produces;
  }

  return schema;
}
