import type { RemoteControlHandle, RemoteControlOptions } from './client';

export type RemoteControlState = 'off' | 'starting' | 'on' | 'stopping';

export interface RemoteControlStatusInfo {
  readonly enabled: boolean;
  readonly state: RemoteControlState;
  readonly url?: string;
  readonly deviceId?: string;
  readonly deviceName?: string;
  readonly error?: string;
}

export interface RemoteControlManager {
  status(): RemoteControlStatusInfo;
  enable(): Promise<RemoteControlStatusInfo>;
  disable(): Promise<RemoteControlStatusInfo>;
  close(): Promise<void>;
}

export interface RemoteControlManagerOptions {
  readonly homeDir: string;
  readonly localOrigin: () => string;
  readonly localServerToken: () => string;
  readonly clientVersion: string;
  readonly relayOrigin?: string;
  readonly stderr?: Pick<NodeJS.WriteStream, 'write'>;
  readonly start: (options: RemoteControlOptions) => Promise<RemoteControlHandle>;
}

export function createRemoteControlManager(
  options: RemoteControlManagerOptions,
): RemoteControlManager {
  let state: RemoteControlState = 'off';
  let handle: RemoteControlHandle | undefined;
  let error: unknown;
  const listeners = new Set<(state: RemoteControlState) => void>();

  const transition = (next: RemoteControlState): void => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  const currentState = (): RemoteControlState => state;

  const waitForState = (predicate: (state: RemoteControlState) => boolean): Promise<void> =>
    new Promise((resolve) => {
      if (predicate(state)) {
        resolve();
        return;
      }
      const listener = (next: RemoteControlState): void => {
        if (!predicate(next)) return;
        listeners.delete(listener);
        resolve();
      };
      listeners.add(listener);
    });

  const status = (): RemoteControlStatusInfo => ({
    enabled: state === 'on',
    state,
    url: handle?.url,
    deviceId: handle?.deviceId,
    deviceName: handle?.deviceName,
    error: error === undefined ? undefined : errorMessage(error),
  });

  const watchTunnel = (started: RemoteControlHandle): void => {
    void started.closed.then(
      () => {
        if (state === 'on' && handle === started) {
          handle = undefined;
          transition('off');
        }
      },
      (cause: unknown) => {
        options.stderr?.write(`remote-control lock release failed: ${errorMessage(cause)}\n`);
        if (state === 'on' && handle === started) {
          handle = undefined;
          transition('off');
        }
      },
    );
  };

  const enable = async (): Promise<RemoteControlStatusInfo> => {
    for (;;) {
      if (state === 'on') return status();
      if (state === 'stopping') {
        await waitForState((current) => current === 'off');
        continue;
      }
      if (state === 'starting') {
        await waitForState((current) => current === 'on' || current === 'off');
        if (currentState() === 'on') return status();
        throw error;
      }
      break;
    }
    transition('starting');
    try {
      const started = await options.start({
        homeDir: options.homeDir,
        localOrigin: options.localOrigin(),
        localServerToken: options.localServerToken,
        clientVersion: options.clientVersion,
        relayOrigin: options.relayOrigin,
        stderr: options.stderr,
      });
      watchTunnel(started);
      handle = started;
      error = undefined;
      transition('on');
    } catch (cause) {
      handle = undefined;
      error = cause;
      transition('off');
    }
    if (currentState() === 'on') return status();
    throw error;
  };

  const disable = async (): Promise<RemoteControlStatusInfo> => {
    for (;;) {
      if (state === 'off') return status();
      if (state === 'starting') {
        await waitForState((current) => current === 'on' || current === 'off');
        continue;
      }
      if (state === 'stopping') {
        await waitForState((current) => current === 'off');
        return status();
      }
      break;
    }
    const current = handle;
    transition('stopping');
    try {
      await current?.close();
    } catch (cause) {
      error = cause;
    }
    handle = undefined;
    transition('off');
    return status();
  };

  const close = async (): Promise<void> => {
    try {
      await disable();
    } catch (cause) {
      options.stderr?.write(`remote-control shutdown failed: ${errorMessage(cause)}\n`);
    }
  };

  return { status, enable, disable, close };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
