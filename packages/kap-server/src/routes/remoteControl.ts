import {
  RemoteControlAlreadyRunningError,
  type RemoteControlManager,
  type RemoteControlStatusInfo,
} from '@moonshot-ai/remote-control';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  remoteControlStatusSchema,
  setRemoteControlRequestSchema,
  type RemoteControlStatusResponse,
} from '../protocol/rest-remote-control';

interface RemoteControlRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export interface RemoteControlRouteOptions {
  readonly service: RemoteControlManager;
  readonly staticEnableError?: string;
}

export function registerRemoteControlRoutes(
  app: RemoteControlRouteHost,
  opts: RemoteControlRouteOptions,
): void {
  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/remote-control',
      success: { data: remoteControlStatusSchema },
      description: 'Get the Remote Control tunnel status',
      tags: ['remote-control'],
    },
    async (req, reply) => {
      reply.send(okEnvelope(toRemoteControlStatusResponse(opts.service.status()), req.id));
    },
  );
  app.get(
    getRoute.path,
    getRoute.options,
    getRoute.handler as Parameters<RemoteControlRouteHost['get']>[2],
  );

  const setRoute = defineRoute(
    {
      method: 'POST',
      path: '/remote-control',
      body: setRemoteControlRequestSchema,
      success: { data: remoteControlStatusSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.REMOTE_CONTROL_ALREADY_RUNNING]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Start or stop the Remote Control tunnel',
      tags: ['remote-control'],
    },
    async (req, reply) => {
      const { enabled } = req.body as { enabled: boolean };
      if (!enabled) {
        const status = await opts.service.disable();
        reply.send(okEnvelope(toRemoteControlStatusResponse(status), req.id));
        return;
      }
      if (opts.staticEnableError !== undefined) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, opts.staticEnableError, req.id));
        return;
      }
      try {
        const status = await opts.service.enable();
        reply.send(okEnvelope(toRemoteControlStatusResponse(status), req.id));
      } catch (error) {
        if (error instanceof RemoteControlAlreadyRunningError) {
          reply.send(
            errEnvelope(ErrorCode.REMOTE_CONTROL_ALREADY_RUNNING, error.message, req.id),
          );
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        requestLog(req)?.error({ err: error }, 'remote-control enable failed');
        reply.send(errEnvelope(ErrorCode.INTERNAL_ERROR, message, req.id));
      }
    },
  );
  app.post(
    setRoute.path,
    setRoute.options,
    setRoute.handler as Parameters<RemoteControlRouteHost['post']>[2],
  );
}

function toRemoteControlStatusResponse(
  status: RemoteControlStatusInfo,
): RemoteControlStatusResponse {
  return {
    enabled: status.enabled,
    state: status.state,
    url: status.url,
    device_id: status.deviceId,
    device_name: status.deviceName,
    error: status.error,
  };
}
