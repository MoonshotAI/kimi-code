import { createFeature, type Feature } from '#/app/index';
import { createFacadeToken, useCleanup, useExpose } from '#/composition-api/index';

import { startRemoteControl, type RemoteControlHandle, type RemoteControlOptions } from './client';
import { createRemoteControlManager, type RemoteControlStatusInfo } from './manager';

export interface RemoteControlFace {
  status(): RemoteControlStatusInfo;
  enable(): Promise<RemoteControlStatusInfo>;
  disable(): Promise<RemoteControlStatusInfo>;
}

export const RemoteControlRef = createFacadeToken<RemoteControlFace>('remote-control');

export interface CreateRemoteControlProps {
  readonly homeDir: string;
  readonly localOrigin: () => string;
  readonly localServerToken: () => string;
  readonly clientVersion: string;
  readonly urlSource: string;
  readonly REMOTE_CONTROL_RELAY_URL?: string;
  readonly configuredOAuthKey?: () => string | undefined;
  readonly configuredOAuthHost?: () => string | undefined;
  readonly stderr?: Pick<NodeJS.WriteStream, 'write'>;
  readonly start?: (options: RemoteControlOptions) => Promise<RemoteControlHandle>;
}

const _REMOTE_CONTROL_RELAY_URL: string | undefined = undefined;

export function createRemoteControl(props: CreateRemoteControlProps): Feature<void> {
  const relayOrigin = props.REMOTE_CONTROL_RELAY_URL ?? _REMOTE_CONTROL_RELAY_URL;
  return createFeature('remote-control', {
    app() {
      const manager = createRemoteControlManager({
        homeDir: props.homeDir,
        localOrigin: props.localOrigin,
        localServerToken: props.localServerToken,
        clientVersion: props.clientVersion,
        urlSource: props.urlSource,
        relayOrigin,
        configuredOAuthKey: props.configuredOAuthKey,
        configuredOAuthHost: props.configuredOAuthHost,
        stderr: props.stderr,
        start: props.start ?? startRemoteControl,
      });
      useExpose(RemoteControlRef, {
        status: () => manager.status(),
        enable: () => manager.enable(),
        disable: () => manager.disable(),
      });
      useCleanup(() => manager.close());
    },
  });
}
