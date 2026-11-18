import {
  DEVICES_SECTION,
  IBootstrapService,
  IConfigService,
  IHostFileSystem,
  deviceIdSchema,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { deviceSnapshotSchema } from '../protocol/events-zod';
import { deviceSnapshots, toDeviceSnapshot, type DeviceManager } from '../services/devices/deviceManager';
import { deviceWireSchema } from '../services/devices/devicesConfig';
import { providerCopyResultSchema } from '../services/devices/deviceProviders';
import { readSshConfigHosts } from '../services/devices/sshConfigHosts';
import { DeviceConnectError, SshDeviceBridge } from '../services/devices/sshDeviceBridge';

interface DevicesRouteHost {
  get(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: never): unknown;
  post(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: never): unknown;
  put(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: never): unknown;
  delete(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: never): unknown;
}

const deviceIdBodySchema = z.object({ id: z.string() });
const testResultSchema = z.object({
  connected: z.boolean(),
  remote_version: z.string().optional(),
  connect_error: z.string().optional(),
  connect_failure: z.string().optional(),
});

export function registerDevicesRoutes(app: DevicesRouteHost, core: Scope, manager: DeviceManager): void {
  const config = core.accessor.get(IConfigService);
  const bootstrap = core.accessor.get(IBootstrapService);
  let devicesWrite: Promise<unknown> = Promise.resolve();

  const mutateDevices = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = devicesWrite.catch(() => undefined).then(fn);
    devicesWrite = next;
    return next;
  };

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/devices',
      success: { data: z.object({ devices: z.array(deviceSnapshotSchema) }) },
      description: 'List configured devices and their connection status',
      tags: ['devices'],
    },
    async (req, reply) => {
      reply.send(okEnvelope({ devices: deviceSnapshots(manager) }, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as never);

  const sshHostsRoute = defineRoute(
    {
      method: 'GET',
      path: '/devices::ssh-hosts',
      success: {
        data: z.object({
          config_path: z.string(),
          exists: z.boolean(),
          hosts: z.array(
            z.object({
              alias: z.string(),
              host_name: z.string().optional(),
              user: z.string().optional(),
              port: z.number().optional(),
            }),
          ),
        }),
      },
      description: 'List concrete Host aliases declared in the local ~/.ssh/config',
      tags: ['devices'],
    },
    async (req, reply) => {
      const result = await readSshConfigHosts(core.accessor.get(IHostFileSystem), bootstrap.osHomeDir);
      reply.send(
        okEnvelope(
          {
            config_path: result.configPath,
            exists: result.exists,
            hosts: result.hosts.map((host) => ({
              alias: host.alias,
              host_name: host.hostName,
              user: host.user,
              port: host.port,
            })),
          },
          req.id,
        ),
      );
    },
  );
  app.get(sshHostsRoute.path, sshHostsRoute.options, sshHostsRoute.handler as never);

  const testRoute = defineRoute(
    {
      method: 'POST',
      path: '/devices::test',
      body: deviceWireSchema,
      success: { data: testResultSchema },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Check SSH connectivity and the remote kimi version without starting a server',
      tags: ['devices'],
    },
    async (req, reply) => {
      const bridge = new SshDeviceBridge(req.body);
      try {
        await bridge.probe();
        reply.send(okEnvelope({ connected: true }, req.id));
      } catch (error) {
        reply.send(
          okEnvelope(
            {
              connected: false,
              remote_version: error instanceof DeviceConnectError ? error.remoteVersion : undefined,
              connect_error: error instanceof Error ? error.message : String(error),
              connect_failure: error instanceof DeviceConnectError ? error.failure : 'unknown',
            },
            req.id,
          ),
        );
      }
    },
  );
  app.post(testRoute.path, testRoute.options, testRoute.handler as never);

  const connectRoute = defineRoute(
    {
      method: 'POST',
      path: '/devices::connect',
      body: deviceIdBodySchema,
      success: { data: deviceSnapshotSchema },
      errors: { [ErrorCode.ENVIRONMENT_NOT_FOUND]: {} },
      description: 'Connect a configured device now; failures are reported in the returned status',
      tags: ['devices'],
    },
    async (req, reply) => {
      const { id } = req.body;
      const error = await manager.connect(id).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error : new Error('device connection failed')),
      );
      const info = manager.list().find((candidate) => candidate.id === id);
      if (info === undefined) {
        reply.send(errEnvelope(ErrorCode.ENVIRONMENT_NOT_FOUND, `device "${id}" is not configured`, req.id));
        return;
      }
      const snapshot = toDeviceSnapshot(info);
      reply.send(
        okEnvelope(
          error !== undefined && snapshot.status === 'pending'
            ? {
                ...snapshot,
                status: 'disconnected',
                connect_error: error.message,
                connect_failure: error instanceof DeviceConnectError ? error.failure : 'unknown',
              }
            : snapshot,
          req.id,
        ),
      );
    },
  );
  app.post(connectRoute.path, connectRoute.options, connectRoute.handler as never);

  const copyProvidersRoute = defineRoute(
    {
      method: 'POST',
      path: '/devices::copy-providers',
      body: deviceIdBodySchema,
      success: { data: providerCopyResultSchema },
      errors: { [ErrorCode.ENVIRONMENT_NOT_FOUND]: {}, [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {} },
      description: 'Copy shareable custom model providers on this computer to a device, replacing providers with the same name there',
      tags: ['devices'],
    },
    async (req, reply) => {
      const { id } = req.body;
      if (manager.section()[id] === undefined) {
        reply.send(errEnvelope(ErrorCode.ENVIRONMENT_NOT_FOUND, `device "${id}" is not configured`, req.id));
        return;
      }
      try {
        reply.send(okEnvelope(await manager.copyProviders(id), req.id));
      } catch (error) {
        reply.send(errEnvelope(ErrorCode.ENVIRONMENT_UNAVAILABLE, error instanceof Error ? error.message : String(error), req.id));
      }
    },
  );
  app.post(copyProvidersRoute.path, copyProvidersRoute.options, copyProvidersRoute.handler as never);

  const putRoute = defineRoute(
    {
      method: 'PUT',
      path: '/devices/{id}',
      params: z.object({ id: deviceIdSchema }),
      body: deviceWireSchema,
      success: { data: z.object({ ok: z.literal(true) }) },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Create or replace a device',
      tags: ['devices'],
    },
    async (req, reply) => {
      await mutateDevices(() => config.replace(DEVICES_SECTION, { ...manager.section(), [req.params.id]: req.body }));
      reply.send(okEnvelope({ ok: true as const }, req.id));
    },
  );
  app.put(putRoute.path, putRoute.options, putRoute.handler as never);

  const deleteRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/devices/{id}',
      params: deviceIdBodySchema,
      success: { data: z.object({ ok: z.literal(true) }) },
      description: 'Remove a device',
      tags: ['devices'],
    },
    async (req, reply) => {
      const { id } = req.params;
      await mutateDevices(async () => {
        const { [id]: _removed, ...rest } = manager.section();
        await config.replace(DEVICES_SECTION, rest);
      });
      reply.send(okEnvelope({ ok: true as const }, req.id));
    },
  );
  app.delete(deleteRoute.path, deleteRoute.options, deleteRoute.handler as never);
}
