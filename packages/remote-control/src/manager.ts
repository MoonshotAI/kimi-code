import { assign, createActor, fromPromise, setup, waitFor } from '@moonshot-ai/agent-core-v2/human/xstate2';

import { startRemoteControl, type RemoteControlHandle } from './remote-control';

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
}

interface RemoteControlMachineContext {
  readonly handle?: RemoteControlHandle;
  readonly error?: unknown;
}

type RemoteControlMachineEvent = { type: 'enable' } | { type: 'disable' } | { type: 'tunnel.exited' };

function createRemoteControlMachine(
  options: RemoteControlManagerOptions,
  onTunnelStarted: (handle: RemoteControlHandle) => void,
) {
  return setup({
    types: {
      context: {} as RemoteControlMachineContext,
      events: {} as RemoteControlMachineEvent,
    },
    actors: {
      startTunnel: fromPromise<RemoteControlHandle, void>(async () => {
        const handle = await startRemoteControl({
          homeDir: options.homeDir,
          localOrigin: options.localOrigin(),
          localServerToken: options.localServerToken(),
          clientVersion: options.clientVersion,
          relayOrigin: options.relayOrigin,
          stderr: options.stderr,
        });
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
        on: { enable: 'starting', 'tunnel.exited': {} },
      },
      starting: {
        on: { enable: {} },
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
  const actor = createActor(
    createRemoteControlMachine(options, (handle) => {
      void handle.closed.then(() => {
        actor.send({ type: 'tunnel.exited' });
      });
    }),
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
    };
  };

  const settle = () =>
    waitFor(actor, (snap) => snap.value === 'on' || snap.value === 'off');

  const enable = async (): Promise<RemoteControlStatusInfo> => {
    const snap = actor.getSnapshot();
    if (snap.value === 'on') return status();
    if (snap.value === 'stopping') {
      await waitFor(actor, (s) => s.value === 'off');
    } else if (snap.value === 'starting') {
      const settled = await settle();
      if (settled.value === 'on') return status();
      throw settled.context.error;
    }
    actor.send({ type: 'enable' });
    const settled = await settle();
    if (settled.value === 'on') return status();
    throw settled.context.error;
  };

  const disable = async (): Promise<RemoteControlStatusInfo> => {
    const snap = actor.getSnapshot();
    if (snap.value === 'off') return status();
    if (snap.value === 'starting') {
      const settled = await settle();
      if (settled.value === 'off') return status();
    } else if (snap.value === 'stopping') {
      await waitFor(actor, (s) => s.value === 'off');
      return status();
    }
    actor.send({ type: 'disable' });
    await waitFor(actor, (s) => s.value === 'off');
    return status();
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
