/**
 * `defineRoute` — single-source-of-truth route declaration helper.
 *
 * One object declares **both** the runtime Zod validators (preHandler) and the
 * Swagger/OpenAPI response schema. The 200-response is automatically expanded
 * into a `oneOf` union that covers the success envelope (code: 0) and every
 * declared error envelope (code: 4xxxx / 5xxxx) with its precise `details`
 * shape.
 *
 * Path params use OpenAPI `{param}` syntax; the helper converts them to
 * Fastify `:param` syntax internally.
 *
 * Example:
 * ```ts
 * const route = defineRoute({
 *   method: 'POST',
 *   path: '/sessions/{session_id}/prompts',
 *   body: promptSubmissionSchema,
 *   params: sessionIdParamSchema,
 *   success: { data: promptSubmitResultSchema },
 *   errors: {
 *     40001: { detailsSchema: z.array(z.object({ path: z.string(), message: z.string() })) },
 *     40110: {},
 *     40111: { detailsSchema: z.object({ provider_id: z.string() }) },
 *     40113: { detailsSchema: z.object({ model_id: z.string() }).partial() },
 *     40401: {},
 *     // Errors that carry non-null data (e.g. idempotent conflicts):
 *     // 40903: { dataSchema: z.object({ aborted: z.literal(false) }) },
 *   },
 *   description: 'Submit a prompt to a session',
 *   tags: ['prompts'],
 * }, async (req, reply) => {
 *   // req.body  → PromptSubmission  (inferred from promptSubmissionSchema)
 *   // req.params → { session_id: string } (inferred from sessionIdParamSchema)
 * });
 *
 * app.post(route.path, route.options, route.handler);
 * ```
 */

import { z } from 'zod';

import { jsonSchema, openApiDocumentJsonSchema } from './schema';
import { validateBody, validateParams, validateQuery } from './validate';

// ---------------------------------------------------------------------------
// Path conversion
// ---------------------------------------------------------------------------

/** Convert OpenAPI `{param}` segments to Fastify `:param` segments. */
function toFastifyPath(openApiPath: string): string {
  return openApiPath.replace(/\{([^}]+)\}/g, ':$1');
}

// ---------------------------------------------------------------------------
// Schema builders
// ---------------------------------------------------------------------------

/** Build a Zod schema for an error envelope with a specific code. */
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

/** Build a Zod schema for the success envelope (code: 0). */
function buildSuccessEnvelopeSchema(successDataSchema: z.ZodTypeAny): z.ZodTypeAny {
  return z.object({
    code: z.literal(0),
    msg: z.string(),
    data: successDataSchema,
    request_id: z.string(),
    details: z.unknown().optional(),
  });
}

/**
 * Build the unified 200-response schema.
 *
 * When error variants are present: returns a `oneOf` array where each variant
 * is an OpenAPI 3 schema object (success first, then errors in ascending code
 * order).
 *
 * When no error variants are present: returns the success envelope schema
 * directly for simpler Swagger output and backward compatibility with tests
 * that expect a plain schema object.
 */
function buildUnifiedResponseSchema(
  successDataSchema: z.ZodTypeAny,
  errors: Record<number, { dataSchema?: z.ZodTypeAny; detailsSchema?: z.ZodTypeAny }>,
): Record<string, unknown> {
  // Error variants — sorted by code for deterministic output
  const errorEntries = Object.entries(errors)
    .map(([code, cfg]) => [Number(code), cfg] as const)
    .sort((a, b) => a[0] - b[0]);

  // No errors → return the plain envelope schema (not wrapped in oneOf)
  if (errorEntries.length === 0) {
    return openApiDocumentJsonSchema(
      buildSuccessEnvelopeSchema(successDataSchema),
      'output',
    );
  }

  const variants: Record<string, unknown>[] = [];

  // Success variant
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InferZod<T extends z.ZodTypeAny | undefined> = T extends z.ZodTypeAny
  ? z.infer<T>
  : unknown;

export interface DefineRouteOptions<
  TBody extends z.ZodTypeAny | undefined,
  TParams extends z.ZodTypeAny | undefined,
  TQuery extends z.ZodTypeAny | undefined,
  TSuccessData extends z.ZodTypeAny | undefined,
> {
  /** HTTP method (used by the consumer for registration bookkeeping). */
  method: string;
  /** Route path with OpenAPI `{param}` syntax. */
  path: string;
  /** Request-body Zod schema. */
  body?: TBody;
  /** Route-params Zod schema. */
  params?: TParams;
  /** Query-string Zod schema. */
  querystring?: TQuery;
  /** Success payload schema (wrapped in envelope code:0 automatically). */
  success?: { data: TSuccessData };
  /**
   * Error variants for the 200-response oneOf.
   * Key = business error code.
   * `dataSchema` defaults to `z.null()`; override for idempotent-conflict
   * shapes such as `{code:40903, data:{aborted:false}}`.
   * `detailsSchema` describes the structured error context when present.
   */
  errors?: Record<number, { dataSchema?: z.ZodTypeAny; detailsSchema?: z.ZodTypeAny }>;
  /**
   * Raw response schemas that are NOT envelope-wrapped.
   * Useful for binary-stream endpoints (e.g. file download).
   */
  rawResponse?: Record<number, Record<string, unknown>>;
  /** Swagger description. */
  description?: string;
  /** Swagger summary. */
  summary?: string;
  /** Swagger tags. */
  tags?: string[];
  /** Swagger operationId. */
  operationId?: string;
  /** Swagger consumes. */
  consumes?: string[];
}

export interface RouteDefinition<
  TBody extends z.ZodTypeAny | undefined,
  TParams extends z.ZodTypeAny | undefined,
  TQuery extends z.ZodTypeAny | undefined,
> {
  method: string;
  /** Fastify-style path (`:param`). */
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
    } & (TQuery extends z.ZodTypeAny ? { query: InferZod<TQuery> } : {}),
    reply: { send(payload: unknown): unknown },
  ) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Declare a route from a single Zod-based definition.
 *
 * Returns a `RouteDefinition` carrying:
 *   - `path`      – converted to Fastify `:param` syntax
 *   - `options`   – `preHandler` (runtime validation) + `schema` (Swagger)
 *   - `handler`   – typed request / reply callback
 *
 * The caller is responsible for registering the definition on the correct
 * app verb, e.g. `app.post(route.path, route.options, route.handler)`.
 */
export function defineRoute<
  TBody extends z.ZodTypeAny | undefined,
  TParams extends z.ZodTypeAny | undefined,
  TQuery extends z.ZodTypeAny | undefined,
  TSuccessData extends z.ZodTypeAny | undefined,
>(
  options: DefineRouteOptions<TBody, TParams, TQuery, TSuccessData>,
  handler: RouteDefinition<TBody, TParams, TQuery>['handler'],
): RouteDefinition<TBody, TParams, TQuery> {
  // -- runtime validators ----------------------------------------------------
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

  // -- swagger schema --------------------------------------------------------
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
