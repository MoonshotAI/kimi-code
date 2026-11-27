import type { Scope } from '@moonshot-ai/agent-core-v2/_base/di/scope';
import { resumeSessionById } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionLookup';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { mediaSignatureSchema } from '../protocol/rest-media-signature';
import type { MediaSignatureService } from '../services/mediaSignature/mediaSignatureService';

interface MediaSignatureRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: MediaSignatureRequest, reply: MediaSignatureReply) => unknown,
  ): unknown;
}

interface MediaSignatureRequest {
  readonly id: string;
  readonly params: { readonly session_id: string };
}

interface MediaSignatureReply {
  send(payload: unknown): unknown;
  code(status: number): MediaSignatureReply;
}

const mediaSignatureParamSchema = z.object({
  session_id: z.string().min(1),
});

export function registerMediaSignatureRoutes(
  app: MediaSignatureRouteHost,
  core: Scope,
  mediaSignatures: MediaSignatureService,
): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/media-signature',
      params: mediaSignatureParamSchema,
      success: { data: mediaSignatureSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.WIRE_VERSION_TOO_LOW]: {},
      },
      description: 'Issue a short-lived signature that authorizes workspace media reads without a bearer token',
      tags: ['fs'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const session = await resumeSessionById(core.accessor, session_id);
      if (session === undefined) {
        const r = reply as unknown as MediaSignatureReply;
        return r
          .code(404)
          .send(
            errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'session not found', req.id),
          ) as unknown as void;
      }
      const issued = mediaSignatures.issue();
      reply.send(
        okEnvelope(
          { signature: issued.signature, expires_at: new Date(issued.expiresAt).toISOString() },
          req.id,
        ),
      );
    },
  );
  app.get(
    route.path,
    route.options,
    route.handler as unknown as Parameters<MediaSignatureRouteHost['get']>[2],
  );
}