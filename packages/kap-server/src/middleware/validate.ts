import { ErrorCode } from '../protocol/error-codes';
import type { z } from 'zod';

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
