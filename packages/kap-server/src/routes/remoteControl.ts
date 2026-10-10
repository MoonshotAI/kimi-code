import {
  RemoteControlAlreadyRunningError,
  type RemoteControlDeviceClient,
  type RemoteControlManager,
  type RemoteControlStatusInfo,
} from '@moonshot-ai/remote-control';

import type { ITelemetryService } from '@moonshot-ai/agent-core-v2';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  remoteControlDeviceListSchema,
  remoteControlDeviceMutationResponseSchema,
  remoteControlDeviceParamsSchema,
  remoteControlStatusSchema,
  renameRemoteControlDeviceRequestSchema,
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
      req: { id: string; body: unknown; params?: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  patch(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export interface RemoteControlRouteOptions {
  readonly service: RemoteControlManager;
  readonly devices: RemoteControlDeviceClient;
  readonly staticEnableError?: string;
  readonly telemetry?: ITelemetryService;
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
        opts.telemetry?.track2('remote_control_toggle', { enabled, outcome: 'ok' });
        reply.send(okEnvelope(toRemoteControlStatusResponse(status), req.id));
        return;
      }
      if (opts.staticEnableError !== undefined) {
        opts.telemetry?.track2('remote_control_toggle', { enabled, outcome: 'rejected' });
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, opts.staticEnableError, req.id));
        return;
      }
      try {
        const status = await opts.service.enable();
        opts.telemetry?.track2('remote_control_toggle', { enabled, outcome: 'ok' });
        reply.send(okEnvelope(toRemoteControlStatusResponse(status), req.id));
      } catch (error) {
        if (error instanceof RemoteControlAlreadyRunningError) {
          opts.telemetry?.track2('remote_control_toggle', { enabled, outcome: 'already_running' });
          reply.send(
            errEnvelope(ErrorCode.REMOTE_CONTROL_ALREADY_RUNNING, error.message, req.id),
          );
          return;
        }
        opts.telemetry?.track2('remote_control_toggle', { enabled, outcome: 'error' });
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

  const handleDeviceRoute = async (
    req: { id: string },
    reply: { send(payload: unknown): unknown },
    operation: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      reply.send(okEnvelope(await operation(), req.id));
    } catch (error) {
      requestLog(req)?.error({ err: error }, 'remote-control device request failed');
      reply.send(
        errEnvelope(
          ErrorCode.INTERNAL_ERROR,
          error instanceof Error ? error.message : String(error),
          req.id,
        ),
      );
    }
  };

  const listDevicesRoute = defineRoute(
    {
      method: 'GET',
      path: '/remote-control/devices',
      success: { data: remoteControlDeviceListSchema },
      errors: { [ErrorCode.INTERNAL_ERROR]: {} },
      description: 'List Remote Control devices',
      tags: ['remote-control'],
    },
    async (req, reply) => {
      await handleDeviceRoute(req, reply, () => opts.devices.listDevices());
    },
  );
  app.get(
    listDevicesRoute.path,
    listDevicesRoute.options,
    listDevicesRoute.handler as Parameters<RemoteControlRouteHost['get']>[2],
  );

  const renameDeviceRoute = defineRoute(
    {
      method: 'PATCH',
      path: '/remote-control/devices/{id}',
      params: remoteControlDeviceParamsSchema,
      body: renameRemoteControlDeviceRequestSchema,
      success: { data: remoteControlDeviceMutationResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Rename a Remote Control device',
      tags: ['remote-control'],
    },
    async (req, reply) => {
      await handleDeviceRoute(req, reply, async () => {
        await opts.devices.renameDevice(req.params.id, req.body.alias);
        return { ok: true };
      });
    },
  );
  app.patch(
    renameDeviceRoute.path,
    renameDeviceRoute.options,
    renameDeviceRoute.handler as Parameters<RemoteControlRouteHost['patch']>[2],
  );

  const deactivateDeviceRoute = defineRoute(
    {
      method: 'POST',
      path: '/remote-control/devices/{id}/deactivate',
      params: remoteControlDeviceParamsSchema,
      success: { data: remoteControlDeviceMutationResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Deactivate a Remote Control device',
      tags: ['remote-control'],
    },
    async (req, reply) => {
      await handleDeviceRoute(req, reply, async () => {
        await opts.devices.deactivateDevice(req.params.id);
        return { ok: true };
      });
    },
  );
  app.post(
    deactivateDeviceRoute.path,
    deactivateDeviceRoute.options,
    deactivateDeviceRoute.handler as Parameters<RemoteControlRouteHost['post']>[2],
  );

  const deleteDeviceRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/remote-control/devices/{id}',
      params: remoteControlDeviceParamsSchema,
      success: { data: remoteControlDeviceMutationResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Delete a Remote Control device',
      tags: ['remote-control'],
    },
    async (req, reply) => {
      await handleDeviceRoute(req, reply, async () => {
        await opts.devices.deleteDevice(req.params.id);
        return { ok: true };
      });
    },
  );
  app.delete(
    deleteDeviceRoute.path,
    deleteDeviceRoute.options,
    deleteDeviceRoute.handler as Parameters<RemoteControlRouteHost['delete']>[2],
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
