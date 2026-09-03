import { ErrorCodes, isError2 } from '@moonshot-ai/agent-core-v2';

import { errEnvelope } from './envelope';
import { ErrorCode } from './protocol/error-codes';
import type { FastifyError } from 'fastify';

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
    if (isError2(err) && err.code === ErrorCodes.CONFIG_INVALID) {
      reply
        .status(200)
        .send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack));
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
