import {
  inspectRemoteControlLock,
  releaseRemoteControlLockHeldBy,
  REMOTE_CONTROL_LOGOUT_GATE_ORIGIN,
  remoteControlLockPath,
  RemoteControlAlreadyRunningError,
  type RemoteControlLockInfo,
} from './lock';
import type { RemoteControlHandle, RemoteControlOptions } from './client';

export type RemoteControlState = 'off' | 'starting' | 'on' | 'stopping';

export interface RemoteControlStatusInfo {
  readonly enabled: boolean;
  readonly state: RemoteControlState;
  readonly url?: string;
  readonly deviceId?: string;
  readonly deviceName?: string;
  readonly error?: string;
  readonly conflict?: RemoteControlLockInfo;
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
  readonly urlSource: string;
  readonly relayOrigin?: string;
  readonly configuredOAuthKey?: () => string | undefined;
  readonly configuredOAuthHost?: () => string | undefined;
  readonly stderr?: Pick<NodeJS.WriteStream, 'write'>;
  readonly start: (options: RemoteControlOptions) => Promise<RemoteControlHandle>;
}

export function createRemoteControlManager(
  options: RemoteControlManagerOptions,
): RemoteControlManager {
  let state: RemoteControlState = 'off';
  let handle: RemoteControlHandle | undefined;
  let error: unknown;
  let startController: AbortController | undefined;
  let startTracker: Promise<void> | undefined;
  let disableRequested = false;
  let queue: Promise<void> = Promise.resolve();
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
    conflict: error instanceof RemoteControlAlreadyRunningError ? error.holder : undefined,
  });

  const watchTunnel = (started: RemoteControlHandle): void => {
    void started.closed.then(
      () => {
        if (currentState() === 'on' && handle === started) {
          handle = undefined;
          transition('off');
        }
      },
      (cause: unknown) => {
        options.stderr?.write(`remote-control lock release failed: ${errorMessage(cause)}\n`);
        if (currentState() === 'on' && handle === started) {
          handle = undefined;
          transition('off');
        }
      },
    );
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const doEnable = async (): Promise<RemoteControlStatusInfo> => {
    if (currentState() === 'on') return status();
    if (currentState() === 'stopping') {
      await waitForState((current) => current === 'off');
    } else if (currentState() === 'starting') {
      await waitForState((current) => current === 'on' || current === 'off');
      if (currentState() === 'on') return status();
      fail(error ?? disabledWhileStarting());
    }
    await startTracker;
    if (disableRequested) fail(disabledWhileStarting());
    if (currentState() === 'on') return status();

    const controller = new AbortController();
    startController = controller;
    error = undefined;
    transition('starting');
    const started = (async () =>
      options.start({
        homeDir: options.homeDir,
        localOrigin: options.localOrigin(),
        localServerToken: options.localServerToken,
        clientVersion: options.clientVersion,
        urlSource: options.urlSource,
        relayOrigin: options.relayOrigin,
        configuredOAuthKey: options.configuredOAuthKey?.(),
        configuredOAuthHost: options.configuredOAuthHost?.(),
        stderr: options.stderr,
        signal: controller.signal,
      }))();
    const tracked = started.then(
      () => undefined,
      () => undefined,
    );
    startTracker = tracked;
    void tracked.then(() => {
      if (startTracker === tracked) startTracker = undefined;
      if (startController === controller) startController = undefined;
    });
    controller.signal.addEventListener(
      'abort',
      () => {
        void started.then(
          (current) => current.close(),
          () => undefined,
        );
      },
      { once: true },
    );

    try {
      const current = await started;
      watchTunnel(current);
      if (controller.signal.aborted) fail(disabledWhileStarting());
      handle = current;
      error = undefined;
      transition('on');
      return status();
    } catch (cause) {
      handle = undefined;
      if (controller.signal.aborted) {
        if (currentState() === 'starting') transition('off');
        fail(disabledWhileStarting());
      }
      error = cause;
      if (currentState() === 'starting') transition('off');
      fail(cause);
    }
  };

  const doDisable = async (): Promise<RemoteControlStatusInfo> => {
    if (currentState() === 'starting') {
      startController?.abort();
      transition('off');
    }
    if (currentState() === 'stopping') {
      await waitForState((current) => current === 'off');
    } else if (currentState() !== 'off') {
      const current = handle;
      transition('stopping');
      try {
        await current?.close();
      } catch (cause) {
        handle = undefined;
        error = cause;
        transition('off');
        fail(cause);
      }
      handle = undefined;
      transition('off');
    }
    await startTracker;
    const leaked = await inspectRemoteControlLock(options.homeDir);
    if (
      leaked !== undefined &&
      leaked.pid === process.pid &&
      leaked.localOrigin !== REMOTE_CONTROL_LOGOUT_GATE_ORIGIN
    ) {
      await releaseRemoteControlLockHeldBy(options.homeDir, process.pid).catch(() => {});
      const remaining = await inspectRemoteControlLock(options.homeDir);
      if (
        remaining !== undefined &&
        remaining.pid === process.pid &&
        remaining.localOrigin !== REMOTE_CONTROL_LOGOUT_GATE_ORIGIN
      ) {
        fail(
          new Error(
            `Remote Control could not release the machine lock at ${remoteControlLockPath(options.homeDir)}; remove it and try again.`,
          ),
        );
      }
    }
    return status();
  };

  const enable = (): Promise<RemoteControlStatusInfo> => {
    disableRequested = false;
    return enqueue(doEnable);
  };

  const disable = (): Promise<RemoteControlStatusInfo> => {
    disableRequested = true;
    if (currentState() === 'starting') {
      startController?.abort();
      transition('off');
    }
    return enqueue(doDisable);
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

function disabledWhileStarting(): Error {
  return new Error('Remote Control was disabled while starting.');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}
