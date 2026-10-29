import type { Scope } from '@moonshot-ai/agent-core-v2';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { DeviceBridgeError, type DeviceRootSnapshot, type DeviceSnapshot } from '../devices/deviceRegistry';
import type { DeviceBridgeHub } from '../devices/bridgeHub';
import { toWireActor } from '../protocol/actor';
import { ErrorCode } from '../protocol/error-codes';
import { mapError } from '../transport/errors';
import {
  deviceSchema,
  listDevicesResponseSchema,
  listRuntimesResponseSchema,
  runtimeCatalogItemSchema,
  type Device,
} from '../protocol/rest-device';

interface DeviceRouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerDeviceRoutes(app: DeviceRouteHost, core: Scope, devices: DeviceBridgeHub): void {
  void core;
  const listDevices = defineRoute(
    {
      method: 'GET',
      path: '/devices',
      success: { data: listDevicesResponseSchema },
      errors: { [ErrorCode.RUNTIME_UNSUPPORTED]: {} },
      description: 'List Desktop devices and their bridge-authorized roots',
      tags: ['devices'],
      operationId: 'listDevices',
    },
    async (req, reply) => {
      try {
        assertEnabled(devices);
        reply.send(okEnvelope({ items: devices.list().map(toWireDevice) }, req.id));
      } catch (error) {
        reply.send(mapError(error, req.id));
      }
    },
  );
  app.get(listDevices.path, listDevices.options, listDevices.handler as Parameters<DeviceRouteHost['get']>[2]);

  const listRuntimes = defineRoute(
    {
      method: 'GET',
      path: '/runtimes',
      success: { data: listRuntimesResponseSchema },
      errors: { [ErrorCode.RUNTIME_UNSUPPORTED]: {} },
      description: 'List central-local and Desktop FS runtime catalog entries',
      tags: ['devices'],
      operationId: 'listRuntimes',
    },
    async (req, reply) => {
      try {
        assertEnabled(devices);
        const items = [
          runtimeCatalogItemSchema.parse({
            runtime_id: 'local',
            kind: 'local',
            display_name: 'Central development machine',
            online: true,
            capabilities: { fs: true, process: true, terminal: true },
          }),
          ...devices.list().map((device) => runtimeCatalogItemSchema.parse({
            runtime_id: device.runtimeId,
            kind: 'desktop',
            device_id: device.deviceId,
            display_name: device.displayName,
            online: device.online,
            capabilities: { fs: true, process: false, terminal: false },
          })),
        ];
        reply.send(okEnvelope({ items }, req.id));
      } catch (error) {
        reply.send(mapError(error, req.id));
      }
    },
  );
  app.get(listRuntimes.path, listRuntimes.options, listRuntimes.handler as Parameters<DeviceRouteHost['get']>[2]);
}

export function toWireDevice(device: DeviceSnapshot): Device {
  return deviceSchema.parse({
    device_id: device.deviceId,
    display_name: device.displayName,
    runtime_id: device.runtimeId,
    online: device.online,
    connection_id: device.connectionId,
    generation: device.generation,
    protocol_version: device.protocolVersion,
    environment: device.environment,
    capabilities: device.capabilities,
    roots: device.roots.map(toWireRoot),
    connected_by: toWireActor(device.connectedBy),
    last_seen_at: device.lastSeenAt,
  });
}

function toWireRoot(root: DeviceRootSnapshot) {
  return {
    root: root.root,
    display_name: root.displayName,
    registered_by: toWireActor(root.registeredBy)!,
    registered_at: root.registeredAt,
    connection_id: root.connectionId,
    generation: root.generation,
  };
}

function assertEnabled(devices: DeviceBridgeHub): void {
  if (!devices.enabled) throw new DeviceBridgeError('runtime.unsupported', 'internal central server experiment is disabled');
}
