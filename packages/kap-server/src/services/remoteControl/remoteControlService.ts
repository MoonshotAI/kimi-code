import {
  RemoteControlAlreadyRunningError,
  startRemoteControl,
  type RemoteControlHandle,
} from '@moonshot-ai/remote-control';

import type { ServerLogger } from '../pinoLoggerService';

export { RemoteControlAlreadyRunningError };

export type RemoteControlState = 'off' | 'starting' | 'on';

export interface RemoteControlStatusInfo {
  readonly enabled: boolean;
  readonly state: RemoteControlState;
  readonly url?: string;
  readonly deviceId?: string;
  readonly deviceName?: string;
  readonly error?: string;
}

export interface IRemoteControlService {
  status(): RemoteControlStatusInfo;
  enable(): Promise<RemoteControlStatusInfo>;
  disable(): Promise<RemoteControlStatusInfo>;
  close(): Promise<void>;
}

export interface RemoteControlServiceDeps {
  readonly homeDir: string;
  readonly localOrigin: () => string;
  readonly localServerToken: () => string;
  readonly clientVersion: string;
  readonly logger: ServerLogger;
}

export function createRemoteControlService(
  deps: RemoteControlServiceDeps,
): IRemoteControlService {
  let state: RemoteControlState = 'off';
  let handle: RemoteControlHandle | undefined;
  let error: string | undefined;
  let starting: Promise<RemoteControlStatusInfo> | undefined;

  const status = (): RemoteControlStatusInfo => ({
    enabled: state === 'on',
    state,
    url: handle?.url,
    deviceId: handle?.deviceId,
    deviceName: handle?.deviceName,
    error,
  });

  const enable = (): Promise<RemoteControlStatusInfo> => {
    if (state === 'on') return Promise.resolve(status());
    if (starting !== undefined) return starting;
    state = 'starting';
    error = undefined;
    starting = (async () => {
      try {
        handle = await startRemoteControl({
          homeDir: deps.homeDir,
          localOrigin: deps.localOrigin(),
          localServerToken: deps.localServerToken(),
          clientVersion: deps.clientVersion,
          stderr: {
            write: (text) => {
              deps.logger.warn(String(text).trimEnd());
              return true;
            },
          },
        });
        state = 'on';
      } catch (cause) {
        state = 'off';
        handle = undefined;
        error = cause instanceof Error ? cause.message : String(cause);
        throw cause;
      } finally {
        starting = undefined;
      }
      return status();
    })();
    return starting;
  };

  const disable = async (): Promise<RemoteControlStatusInfo> => {
    if (starting !== undefined) {
      try {
        await starting;
      } catch {}
    }
    const current = handle;
    handle = undefined;
    state = 'off';
    if (current !== undefined) await current.close();
    return status();
  };

  const close = async (): Promise<void> => {
    try {
      await disable();
    } catch (cause) {
      deps.logger.warn(
        { err: cause instanceof Error ? cause : new Error(String(cause)) },
        'remote-control shutdown failed; continuing server cleanup',
      );
    }
  };

  return { status, enable, disable, close };
}
