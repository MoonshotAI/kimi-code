import { assign, createActor, fromPromise, setup, waitFor } from '@moonshot-ai/agent-core-v2/human/xstate2';

import {
  inspectRemoteControlLock,
  releaseRemoteControlLockHeldBy,
  REMOTE_CONTROL_LOGOUT_GATE_ORIGIN,
  remoteControlLockPath,
  RemoteControlAlreadyRunningError,
  type RemoteControlLockInfo,
} from './lock';
import { startRemoteControl, type RemoteControlHandle } from './remote-control';

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
}

interface RemoteControlMachineContext {
  readonly handle?: RemoteControlHandle;
  readonly error?: unknown;
}

type RemoteControlMachineEvent = { type: 'enable' } | { type: 'disable' } | { type: 'tunnel.exited' };

function createRemoteControlMachine(
  options: RemoteControlManagerOptions,
  onTunnelStarted: (handle: RemoteControlHandle) => void,
  startTracker: { current?: Promise<void> },
) {
  return setup({
    types: {
      context: {} as RemoteControlMachineContext,
      events: {} as RemoteControlMachineEvent,
    },
    actors: {
      startTunnel: fromPromise<RemoteControlHandle, void>(async ({ signal }) => {
        const started = startRemoteControl({
          homeDir: options.homeDir,
          localOrigin: options.localOrigin(),
          localServerToken: options.localServerToken,
          clientVersion: options.clientVersion,
          urlSource: options.urlSource,
          relayOrigin: options.relayOrigin,
          configuredOAuthKey: options.configuredOAuthKey?.(),
          configuredOAuthHost: options.configuredOAuthHost?.(),
          stderr: options.stderr,
          signal,
        });
        const tracked = started.then(
          () => undefined,
          () => undefined,
        );
        startTracker.current = tracked;
        void tracked.then(() => {
          if (startTracker.current === tracked) {
            startTracker.current = undefined;
          }
        });
        signal.addEventListener('abort', () => {
          void started.then(
            (handle) => handle.close(),
            () => undefined,
          );
        });
        const handle = await started;
        onTunnelStarted(handle);
        return handle;
      }),
      stopTunnel: fromPromise<void, RemoteControlHandle | undefined>(async ({ input }) => {
        await input?.close();
      }),
    },
  }).createMachine({
    id: 'remoteControl',
    initial: 'off',
    context: { handle: undefined, error: undefined },
    states: {
      off: {
        on: {
          enable: { target: 'starting', actions: assign({ error: undefined }) },
          'tunnel.exited': {},
        },
      },
      starting: {
        on: { enable: {}, disable: 'off' },
        invoke: {
          src: 'startTunnel',
          onDone: {
            target: 'on',
            actions: assign({ handle: ({ event }) => event.output, error: undefined }),
          },
          onError: {
            target: 'off',
            actions: assign({ handle: undefined, error: ({ event }) => event.error }),
          },
        },
      },
      on: {
        on: {
          disable: 'stopping',
          'tunnel.exited': { target: 'off', actions: assign({ handle: undefined }) },
        },
      },
      stopping: {
        on: { disable: {}, 'tunnel.exited': {} },
        invoke: {
          src: 'stopTunnel',
          input: ({ context }) => context.handle,
          onDone: { target: 'off', actions: assign({ handle: undefined }) },
          onError: {
            target: 'off',
            actions: assign({ handle: undefined, error: ({ event }) => event.error }),
          },
        },
      },
    },
  });
}

export function createRemoteControlManager(
  options: RemoteControlManagerOptions,
): RemoteControlManager {
  const startTracker: { current?: Promise<void> } = {};
  const actor = createActor(
    createRemoteControlMachine(
      options,
      (handle) => {
        void handle.closed.then(
          () => {
            actor.send({ type: 'tunnel.exited' });
          },
          (error) => {
            options.stderr?.write(`remote-control lock release failed: ${errorMessage(error)}\n`);
            actor.send({ type: 'tunnel.exited' });
          },
        );
      },
      startTracker,
    ),
  );
  actor.start();

  const status = (): RemoteControlStatusInfo => {
    const snap = actor.getSnapshot();
    const state = snap.value as RemoteControlState;
    const handle = snap.context.handle;
    const error = snap.context.error;
    return {
      enabled: state === 'on',
      state,
      url: handle?.url,
      deviceId: handle?.deviceId,
      deviceName: handle?.deviceName,
      error: error === undefined ? undefined : errorMessage(error),
      conflict:
        error instanceof RemoteControlAlreadyRunningError ? error.holder : undefined,
    };
  };

  const settle = () =>
    waitFor(actor, (snap) => snap.value === 'on' || snap.value === 'off');

  let queue: Promise<void> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  let disableRequested = false;

  const doEnable = async (): Promise<RemoteControlStatusInfo> => {
    const snap = actor.getSnapshot();
    if (snap.value === 'on') return status();
    if (snap.value === 'stopping') {
      await waitFor(actor, (s) => s.value === 'off');
    } else if (snap.value === 'starting') {
      const settled = await settle();
      if (settled.value === 'on') return status();
      fail(settled.context.error ?? new Error('Remote Control was disabled while starting.'));
    }
    await startTracker.current;
    if (disableRequested) fail(new Error('Remote Control was disabled while starting.'));
    actor.send({ type: 'enable' });
    const settled = await settle();
    if (settled.value === 'on') return status();
    fail(settled.context.error ?? new Error('Remote Control was disabled while starting.'));
  };

  const doDisable = async (): Promise<RemoteControlStatusInfo> => {
    const snap = actor.getSnapshot();
    if (snap.value !== 'off') {
      actor.send({ type: 'disable' });
      const settled = await waitFor(actor, (s) => s.value === 'off');
      if (settled.context.error !== undefined) fail(settled.context.error);
    }
    await startTracker.current;
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
    if (actor.getSnapshot().value === 'starting') {
      actor.send({ type: 'disable' });
    }
    return enqueue(doDisable);
  };

  const close = async (): Promise<void> => {
    try {
      await disable();
    } catch (error) {
      options.stderr?.write(`remote-control shutdown failed: ${errorMessage(error)}\n`);
    } finally {
      actor.stop();
    }
  };

  return { status, enable, disable, close };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}
