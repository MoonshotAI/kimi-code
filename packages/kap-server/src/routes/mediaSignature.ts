import { z } from 'zod';

import { okEnvelope } from '../envelope';
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
  readonly query: {
    readonly path: string;
    readonly allow_external_symlinks?: 'true' | 'false';
  };
}

interface MediaSignatureReply {
  send(payload: unknown): unknown;
}

const mediaSignatureParamSchema = z.object({
  session_id: z.string().min(1),
});

const mediaSignatureQuerySchema = z.object({
  path: z.string().min(1),
  allow_external_symlinks: z.enum(['true', 'false']).optional(),
});

export function registerMediaSignatureRoutes(
  app: MediaSignatureRouteHost,
  mediaSignatures: MediaSignatureService,
): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/media-signature',
      params: mediaSignatureParamSchema,
      querystring: mediaSignatureQuerySchema,
      success: { data: mediaSignatureSchema },
      errors: {
        [ErrorCode.WIRE_VERSION_TOO_LOW]: {},
      },
      description: 'Issue a short-lived signature bound to one workspace file for bearer-less range reads',
      tags: ['fs'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const issued = mediaSignatures.issue({
        sessionId: session_id,
        path: req.query.path,
        allowExternalSymlinks: req.query.allow_external_symlinks === 'true',
      });
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