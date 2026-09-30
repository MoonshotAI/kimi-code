import { useInject } from '@moonshot-ai/agent-core';

import {
  RemoteControlAlreadyRunningError,
  RemoteControlRef,
  type RemoteControlFace,
  type RemoteControlStatusInfo,
} from '#/feature-remote-control/index';

import { useHttpRoute } from '../feature';
import { ErrorCode, sendErr, sendOk } from '../route/http';

export interface RemoteControlStatusView {
  readonly enabled: boolean;
  readonly state: RemoteControlStatusInfo['state'];
  readonly url?: string;
  readonly device_id?: string;
  readonly device_name?: string;
  readonly error?: string;
}

export function useRemoteControlRoutes(prefix: string): void {
  useHttpRoute({
    id: 'remote-control.status',
    method: 'GET',
    path: `${prefix}/remote-control`,
    handler: async (request, response) => {
      const facade = remoteControlFacade();
      if (facade === undefined) {
        sendUnavailable(request, response);
        return;
      }
      sendOk(request, response, remoteControlStatusView(facade.status()));
    },
  });

  useHttpRoute({
    id: 'remote-control.set',
    method: 'POST',
    path: `${prefix}/remote-control`,
    handler: async (request, response) => {
      const enabled = readEnabled(request.body);
      if (enabled === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'enabled must be a boolean', 400);
        return;
      }
      const facade = remoteControlFacade();
      if (facade === undefined) {
        sendUnavailable(request, response);
        return;
      }
      if (!enabled) {
        sendOk(request, response, remoteControlStatusView(await facade.disable()));
        return;
      }
      try {
        sendOk(request, response, remoteControlStatusView(await facade.enable()));
      } catch (error) {
        if (error instanceof RemoteControlAlreadyRunningError) {
          sendErr(request, response, ErrorCode.REMOTE_CONTROL_ALREADY_RUNNING, error.message, 409);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        sendErr(request, response, ErrorCode.REMOTE_CONTROL_FAILED, message, 500);
      }
    },
  });
}

function remoteControlFacade(): RemoteControlFace | undefined {
  return useInject(RemoteControlRef).value;
}

function sendUnavailable(request: Parameters<typeof sendErr>[0], response: Parameters<typeof sendErr>[1]): void {
  sendErr(
    request,
    response,
    ErrorCode.REMOTE_CONTROL_UNAVAILABLE,
    'remote control is unavailable (remote-control feature is not installed)',
    409,
  );
}

function readEnabled(body: unknown): boolean | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }
  const enabled = (body as { enabled?: unknown }).enabled;
  return typeof enabled === 'boolean' ? enabled : undefined;
}

function remoteControlStatusView(status: RemoteControlStatusInfo): RemoteControlStatusView {
  return {
    enabled: status.enabled,
    state: status.state,
    url: status.url,
    device_id: status.deviceId,
    device_name: status.deviceName,
    error: status.error,
  };
}
