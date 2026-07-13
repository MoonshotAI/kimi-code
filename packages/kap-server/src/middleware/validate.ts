/**
 * Generic Zod body / query / params validators for Fastify routes.
 *
 * On validation success: the parsed value replaces the raw input on the
 * request object so handlers operate on a `T`-typed payload (no need to
 * re-parse). On failure: we send a `40001 validation.failed` envelope with a
 * `details` array of `{path, message}` issues (REST.md §1.4) and return early
 * — the handler does not run.
 *
 * The envelope shape matches `errEnvelope(40001, ...)` with the extra
 * `details` field at top level. REST.md §1.4 specifies `details` as a free
 * field per code; for `40001` clients expect `Array<{path, message}>` so they
 * can highlight the offending field. We extend `errEnvelope`'s output rather
 * than reshape it — this is the single error code that carries structured
 * details so a one-off shape is acceptable.
 *
 * Note: route-level Zod failures land here at the preHandler stage and never
 * reach the generic error hook, which only emits 50001 for unknown exceptions.
 */

import { ErrorCode } from '@moonshot-ai/protocol';
import type { z } from 'zod';

/**
 * Minimal Fastify request/reply shapes — keep our hook independent of the
 * concrete generic parameters so it works against the server's pino-typed
 * variant without TS friction.
 */
interface ValidationRequest {
  id: string;
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

interface ValidationReply {
  send(payload: unknown): unknown;
}

type PreHandlerHook = (
  req: ValidationRequest,
  reply: ValidationReply,
  done: (err?: Error) => void,
) => void;

interface ValidationDetailItem {
  path: string;
  message: string;
}

function zodIssuesToDetails(error: z.ZodError): ValidationDetailItem[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function buildValidationEnvelope(
  details: ValidationDetailItem[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: ValidationDetailItem[];
} {
  const first = details[0];
  const msg = first === undefined
    ? 'validation failed'
    : first.path === ''
      ? first.message
      : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
  };
}

/**
 * Build a Fastify `preHandler` that parses `req.body` against `schema`.
 * On success, replaces `req.body` with the parsed value.
 */
export function validateBody<T>(schema: z.ZodType<T>): PreHandlerHook {
  return (req, reply, done) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      reply.send(buildValidationEnvelope(zodIssuesToDetails(result.error), req.id));
      return;
    }
    req.body = result.data;
    done();
  };
}

/**
 * Build a Fastify `preHandler` that parses `req.query` against `schema`.
 * On success, replaces `req.query` with the parsed value.
 *
 * Fastify deserializes query strings as `Record<string, string>` — so numeric
 * fields arrive as strings. The schema is responsible for coercing
 * (`z.coerce.number()` etc.) when needed; we don't pre-coerce here.
 */
export function validateQuery<T>(schema: z.ZodType<T>): PreHandlerHook {
  return (req, reply, done) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      reply.send(buildValidationEnvelope(zodIssuesToDetails(result.error), req.id));
      return;
    }
    req.query = result.data;
    done();
  };
}

/**
 * Build a Fastify `preHandler` that parses `req.params` against `schema`.
 */
export function validateParams<T>(schema: z.ZodType<T>): PreHandlerHook {
  return (req, reply, done) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      reply.send(buildValidationEnvelope(zodIssuesToDetails(result.error), req.id));
      return;
    }
    req.params = result.data;
    done();
  };
}
