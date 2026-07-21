/**
 * Fastify error hook for unhandled server exceptions.
 *
 * Wraps unhandled exceptions in the Feishu-style envelope:
 *   - HTTP status ALWAYS 200 (business outcome lives in `code`);
 *   - `code: 50001` (`internal.error`) for unknown exceptions;
 *   - `code: 40921` (`session.held_by_peer`) when the session's write lease is
 *     held by a sibling instance — the structured ownership details ride the
 *     envelope so the client can redirect or retry (routes without a local
 *     error switch — approvals, questions, skills — resume sessions
 *     unguarded and land here);
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

import { ErrorCodes, isError2 } from '@moonshot-ai/agent-core-v2';
import { errEnvelope, ownershipRedirectEnvelope } from './envelope';
import { ErrorCode } from './protocol/error-codes';
import type { FastifyError } from 'fastify';

/**
 * Loose Fastify-instance shape so this helper accepts both the default
 * `FastifyInstance` and the server's pino-typed variant
 * (`FastifyInstance<…, ServerLogger>`). The type checker chokes on the
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
    // Session-ownership contention is an expected multi-server outcome, not a
    // server failure: surface 40921 with the structured details (phase /
    // redirect address) and keep the stack in the log only.
    if (isError2(err) && err.code === ErrorCodes.SESSION_HELD_BY_PEER) {
      reply.status(200).send(ownershipRedirectEnvelope(err, requestId));
      return;
    }
    req.log.error({ err, request_id: requestId }, 'unhandled error');
    reply.status(200).send(
      errEnvelope(
        ErrorCode.INTERNAL_ERROR,
        err.message !== undefined && err.message !== '' ? err.message : 'internal error',
        requestId,
        err.stack,
      ),
    );
  });
}
