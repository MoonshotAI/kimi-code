import { envelopeSchema } from '../protocol/envelope';
import { z } from 'zod';

export function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return jsonSchemaForTarget(schema, 'input', 'draft-7');
}

export function outputJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return jsonSchemaForTarget(schema, 'output', 'draft-7');
}

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

export interface RouteSchemaOptions {
  body?: z.ZodTypeAny;
  querystring?: z.ZodTypeAny;
  params?: z.ZodTypeAny;
  response?: Record<number, z.ZodTypeAny>;
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
