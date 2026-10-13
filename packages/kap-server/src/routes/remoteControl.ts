import {
  acquireRemoteControlLock,
  inspectRemoteControlLock,
  REMOTE_CONTROL_LOGOUT_GATE_ORIGIN,
  RemoteControlAlreadyRunningError,
  type RemoteControlDeviceClient,
  type RemoteControlLock,
  type RemoteControlManager,
  type RemoteControlStatusInfo,
} from '@moonshot-ai/remote-control';
import { createKimiDeviceId } from '@moonshot-ai/kimi-code-oauth';

import type { ITelemetryService } from '@moonshot-ai/agent-core-v2';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  remoteControlAlreadyRunningDetailsSchema,
  remoteControlDeviceListSchema,
  remoteControlDeviceMutationResponseSchema,
  remoteControlDeviceParamsSchema,
  remoteControlStatusSchema,
  renameRemoteControlDeviceRequestSchema,
  setRemoteControlRequestSchema,
  type RemoteControlAlreadyRunningDetails,
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
  readonly homeDir: string;
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
      const status = opts.service.status();
      let conflict = status.conflict;
      let error = status.error;
      if (status.state === 'off') {
        try {
          const holder = await inspectRemoteControlLock(opts.homeDir);
          if (holder !== undefined) {
            conflict = holder;
          } else if (conflict !== undefined) {
            conflict = undefined;
            error = undefined;
          }
        } catch (inspectError) {
          requestLog(req)?.error({ err: inspectError }, 'remote-control lock inspection failed');
        }
      }
      reply.send(
        okEnvelope(
          toRemoteControlStatusResponse({ ...status, error, conflict }),
          req.id,
        ),
      );
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
        [ErrorCode.REMOTE_CONTROL_ALREADY_RUNNING]: {
          detailsSchema: remoteControlAlreadyRunningDetailsSchema,
        },
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Start or stop the Remote Control tunnel',
      tags: ['remote-control'],
    },
    async (req, reply) => {
      const { enabled } = req.body as { enabled: boolean };
      if (!enabled) {
        try {
          const status = await opts.service.disable();
          opts.telemetry?.track2('remote_control_toggle', { enabled, outcome: 'ok' });
          reply.send(okEnvelope(toRemoteControlStatusResponse(status), req.id));
        } catch (error) {
          opts.telemetry?.track2('remote_control_toggle', { enabled, outcome: 'error' });
          const message = error instanceof Error ? error.message : String(error);
          requestLog(req)?.error({ err: error }, 'remote-control disable failed');
          reply.send(errEnvelope(ErrorCode.INTERNAL_ERROR, message, req.id));
        }
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
            errEnvelope(ErrorCode.REMOTE_CONTROL_ALREADY_RUNNING, error.message, req.id, undefined, {
              pid: error.holder.pid,
              local_origin: error.holder.localOrigin,
              device_id: error.holder.deviceId,
              url: error.holder.url,
              started_at: error.holder.startedAt,
            } satisfies RemoteControlAlreadyRunningDetails),
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
        const status = opts.service.status();
        const holder = await inspectRemoteControlLock(opts.homeDir);
        const isLocal =
          req.params.id === createKimiDeviceId(opts.homeDir) ||
          status.deviceId === req.params.id ||
          holder?.deviceId === req.params.id;
        if (!isLocal) {
          await opts.devices.deactivateDevice(req.params.id);
          return { ok: true };
        }
        if (status.state !== 'off') {
          await opts.service.disable();
        }
        const gate = await acquireRemoteControlStartGate(opts.homeDir, opts.devices);
        try {
          await opts.devices.deactivateDevice(req.params.id);
          await opts.service.disable();
        } finally {
          await gate.release();
        }
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
        const status = opts.service.status();
        const holder = await inspectRemoteControlLock(opts.homeDir);
        const isLocal =
          req.params.id === createKimiDeviceId(opts.homeDir) ||
          status.deviceId === req.params.id ||
          holder?.deviceId === req.params.id;
        if (!isLocal) {
          await opts.devices.deleteDevice(req.params.id);
          return { ok: true };
        }
        if (status.state !== 'off') {
          await opts.service.disable();
        }
        const gate = await acquireRemoteControlStartGate(opts.homeDir, opts.devices);
        try {
          await opts.devices.deleteDevice(req.params.id);
          await opts.service.disable();
        } finally {
          await gate.release();
        }
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

const LOCK_RELEASE_POLL_MS = 100;
const LOCK_RELEASE_TIMEOUT_MS = 5000;
const START_GATE_TIMEOUT_MS = 10000;

export { REMOTE_CONTROL_LOGOUT_GATE_ORIGIN };

export async function waitForLockRelease(homeDir: string): Promise<void> {
  const deadline = Date.now() + LOCK_RELEASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await inspectRemoteControlLock(homeDir)) === undefined) return;
    await new Promise((resolve) => {
      setTimeout(resolve, LOCK_RELEASE_POLL_MS);
    });
  }
  throw new Error(
    'Remote Control is still running in another process on this machine and did not stop in time. Stop it there and try again.',
  );
}

export async function acquireRemoteControlStartGate(
  homeDir: string,
  devices: Pick<RemoteControlDeviceClient, 'deactivateDevice'>,
): Promise<RemoteControlLock> {
  const deadline = Date.now() + START_GATE_TIMEOUT_MS;
  for (;;) {
    try {
      return await acquireRemoteControlLock(homeDir, {
        localOrigin: REMOTE_CONTROL_LOGOUT_GATE_ORIGIN,
        deviceId: createKimiDeviceId(homeDir),
        url: '',
      });
    } catch (error) {
      if (!(error instanceof RemoteControlAlreadyRunningError) || Date.now() >= deadline) {
        throw error;
      }
      if (error.holder.localOrigin !== REMOTE_CONTROL_LOGOUT_GATE_ORIGIN) {
        await devices.deactivateDevice(error.holder.deviceId);
      }
      await waitForLockRelease(homeDir);
    }
  }
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
    conflict:
      status.conflict === undefined
        ? undefined
        : {
            pid: status.conflict.pid,
            local_origin: status.conflict.localOrigin,
            device_id: status.conflict.deviceId,
            url: status.conflict.url,
            started_at: status.conflict.startedAt,
          },
  };
}
