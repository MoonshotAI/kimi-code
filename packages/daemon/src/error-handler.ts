/**
 * Fastify error hook for unhandled daemon exceptions.
 *
 * Wraps unhandled exceptions in the Feishu-style envelope:
 *   - HTTP status ALWAYS 200 (business outcome lives in `code`);
 *   - `code: 50001` (`internal.error`) for unknown exceptions;
 *   - `request_id` echoes the inbound request id (set by Fastify's
 *     `genReqId` via `resolveRequestId`);
 *   - `data: null`.
 *
 * Validation failures are handled by route-level middleware as 40001
 * `validation.failed`; this handler remains the catch-all unknown-exception path.
 *
 * The handler logs `err` + the resolved `request_id` so operators can
 * correlate log lines with the envelope returned to the client. This is the
 * single place a stack trace ever crosses our process boundary into a log —
 * we never bleed it into the JSON response.
 */

import { errEnvelope, ErrorCode } from '@moonshot-ai/protocol';
import type { FastifyError } from 'fastify';

/**
 * Loose Fastify-instance shape so this helper accepts both the default
 * `FastifyInstance` and the daemon's pino-typed variant
 * (`FastifyInstance<…, DaemonLogger>`). The type checker chokes on the
 * concrete generic mismatch otherwise.
 */
interface ErrorHandlerHost {
  setErrorHandler(
    handler: (
      err: FastifyError,
      req: { id: string; log: { error: (obj: object | string, msg?: string) => void } },
      reply: { status(code: number): { send(payload: unknown): void } },
    ) => void,
  ): unknown;
}

export function installErrorHandler(app: ErrorHandlerHost): void {
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    req.log.error({ err, request_id: requestId }, 'unhandled error');
    reply.status(200).send(
      errEnvelope(
        ErrorCode.INTERNAL_ERROR,
        err.message !== undefined && err.message !== '' ? err.message : 'internal error',
        requestId,
      ),
    );
  });
}

