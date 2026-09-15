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
