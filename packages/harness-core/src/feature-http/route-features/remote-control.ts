import { useInject } from '@moonshot-ai/agent-core/kernel/index';

import {
  RemoteControlAlreadyRunningError,
  RemoteControlRef,
  type RemoteControlFace,
  type RemoteControlState,
  type RemoteControlStatusInfo,
} from '#/feature-remote-control/index';

import { useHttpRoute } from '../scope';
import { ErrorCode, sendErr, sendOk } from '../route/http';

export {
  RemoteControlAlreadyRunningError,
  RemoteControlRef,
  type RemoteControlFace,
  type RemoteControlState,
  type RemoteControlStatusInfo,
};

export interface RemoteControlStatusView {
  readonly enabled: boolean;
  readonly state: RemoteControlStatusInfo['state'];
  readonly url?: string;
  readonly device_id?: string;
  readonly device_name?: string;
  readonly error?: string;
}

export function useRemoteControlRoutes(prefix: string): void {
  const facade = useInject(RemoteControlRef);
  useHttpRoute({
    id: 'remote-control.status',
    method: 'GET',
    path: `${prefix}/remote-control`,
    handler: async (request, response) => {
      const current = facade.value;
      if (current === undefined) {
        sendUnavailable(request, response);
        return;
      }
      sendOk(request, response, remoteControlStatusView(current.status()));
    },
  });

  useHttpRoute({
    id: 'remote-control.set',
    method: 'POST',
    path: `${prefix}/remote-control`,
    handler: async (request, response) => {
      const enabled = readEnabled(request.body);
      if (enabled === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'enabled must be a boolean');
        return;
      }
      const current = facade.value;
      if (current === undefined) {
        sendUnavailable(request, response);
        return;
      }
      if (!enabled) {
        sendOk(request, response, remoteControlStatusView(await current.disable()));
        return;
      }
      try {
        sendOk(request, response, remoteControlStatusView(await current.enable()));
      } catch (error) {
        if (error instanceof RemoteControlAlreadyRunningError) {
          sendErr(request, response, ErrorCode.REMOTE_CONTROL_ALREADY_RUNNING, error.message);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        sendErr(request, response, ErrorCode.REMOTE_CONTROL_FAILED, message);
      }
    },
  });
}

function sendUnavailable(request: Parameters<typeof sendErr>[0], response: Parameters<typeof sendErr>[1]): void {
  sendErr(
    request,
    response,
    ErrorCode.REMOTE_CONTROL_UNAVAILABLE,
    'remote control is unavailable (remote-control feature is not installed)',
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
