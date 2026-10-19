import { z } from 'zod';

import { jsonSchema, openApiDocumentJsonSchema } from './schema';
import { validateBody, validateParams, validateQuery } from './validate';

function toFastifyPath(openApiPath: string): string {
  return openApiPath.replace(/\{([^}]+)\}/g, ':$1');
}

function buildErrorEnvelopeSchema(
  code: number,
  dataSchema: z.ZodTypeAny = z.null(),
  detailsSchema?: z.ZodTypeAny,
): z.ZodTypeAny {
  const base = z.object({
    code: z.literal(code),
    msg: z.string(),
    data: dataSchema,
    request_id: z.string(),
  });

  if (detailsSchema) {
    return base.extend({
      details: detailsSchema.nullable().optional(),
    });
  }

  return base.extend({
    details: z.unknown().optional(),
  });
}

function buildSuccessEnvelopeSchema(successDataSchema: z.ZodTypeAny): z.ZodTypeAny {
  return z.object({
    code: z.literal(0),
    msg: z.string(),
    data: successDataSchema,
    request_id: z.string(),
    details: z.unknown().optional(),
  });
}

function buildUnifiedResponseSchema(
  successDataSchema: z.ZodTypeAny,
  errors: Record<number, { dataSchema?: z.ZodTypeAny; detailsSchema?: z.ZodTypeAny }>,
): Record<string, unknown> {
  const errorEntries = Object.entries(errors)
    .map(([code, cfg]) => [Number(code), cfg] as const)
    .sort((a, b) => a[0] - b[0]);

  if (errorEntries.length === 0) {
    return openApiDocumentJsonSchema(
      buildSuccessEnvelopeSchema(successDataSchema),
      'output',
    );
  }

  const variants: Record<string, unknown>[] = [];

  variants.push(
    openApiDocumentJsonSchema(
      buildSuccessEnvelopeSchema(successDataSchema),
      'output',
    ),
  );

  for (const [code, cfg] of errorEntries) {
    variants.push(
      openApiDocumentJsonSchema(
        buildErrorEnvelopeSchema(code, cfg.dataSchema, cfg.detailsSchema),
        'output',
      ),
    );
  }

  return { oneOf: variants };
}

type InferZod<T extends z.ZodTypeAny | undefined> = T extends z.ZodTypeAny
  ? z.infer<T>
  : unknown;

export interface DefineRouteOptions<
  TBody extends z.ZodTypeAny | undefined,
  TParams extends z.ZodTypeAny | undefined,
  TQuery extends z.ZodTypeAny | undefined,
  TSuccessData extends z.ZodTypeAny | undefined,
> {
  method: string;
  path: string;
  body?: TBody;
  params?: TParams;
  querystring?: TQuery;
  success?: { data: TSuccessData };
  errors?: Record<number, { dataSchema?: z.ZodTypeAny; detailsSchema?: z.ZodTypeAny }>;
  rawResponse?: Record<number, Record<string, unknown>>;
  description?: string;
  summary?: string;
  tags?: string[];
  operationId?: string;
  consumes?: string[];
}

export interface RouteDefinition<
  TBody extends z.ZodTypeAny | undefined,
  TParams extends z.ZodTypeAny | undefined,
  TQuery extends z.ZodTypeAny | undefined,
> {
  method: string;
  path: string;
  options: {
    preHandler: unknown[];
    schema: Record<string, unknown>;
  };
  handler: (
    req: {
      id: string;
      body: InferZod<TBody>;
      params: InferZod<TParams>;
      headers: Record<string, unknown>;
    } & (TQuery extends z.ZodTypeAny ? { query: InferZod<TQuery> } : {}),
    reply: { send(payload: unknown): unknown },
  ) => Promise<void> | void;
}

export function defineRoute<
  TBody extends z.ZodTypeAny | undefined,
  TParams extends z.ZodTypeAny | undefined,
  TQuery extends z.ZodTypeAny | undefined,
  TSuccessData extends z.ZodTypeAny | undefined,
>(
  options: DefineRouteOptions<TBody, TParams, TQuery, TSuccessData>,
  handler: RouteDefinition<TBody, TParams, TQuery>['handler'],
): RouteDefinition<TBody, TParams, TQuery> {
  const preHandler: unknown[] = [];

  if (options.params) {
    preHandler.push(validateParams(options.params));
  }
  if (options.body) {
    preHandler.push(validateBody(options.body));
  }
  if (options.querystring) {
    preHandler.push(validateQuery(options.querystring));
  }

  const schema: Record<string, unknown> = {};

  if (options.body) {
    schema['body'] = jsonSchema(options.body);
  }
  if (options.params) {
    schema['params'] = jsonSchema(options.params);
  }
  if (options.querystring) {
    schema['querystring'] = jsonSchema(options.querystring);
  }

  const hasResponse =
    options.success !== undefined ||
    (options.errors !== undefined && Object.keys(options.errors).length > 0) ||
    options.rawResponse !== undefined;

  if (hasResponse) {
    const responses: Record<string, unknown> = {};

    if (options.success || options.errors) {
      responses['200'] = buildUnifiedResponseSchema(
        options.success?.data ?? z.null(),
        options.errors ?? {},
      );
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

  return {
    method: options.method,
    path: toFastifyPath(options.path),
    options: { preHandler, schema },
    handler,
  };
}
