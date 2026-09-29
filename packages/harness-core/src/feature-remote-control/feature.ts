import { createFeature, type FeatureSpec } from '@moonshot-ai/agent-core';
import { createToken, pushCleanup, useExpose, useNode } from '@moonshot-ai/agent-core/kernel/index';

import { startRemoteControl, type RemoteControlHandle, type RemoteControlOptions } from './client';
import { createRemoteControlManager, type RemoteControlStatusInfo } from './manager';

export interface RemoteControlFace {
  status(): RemoteControlStatusInfo;
  enable(): Promise<RemoteControlStatusInfo>;
  disable(): Promise<RemoteControlStatusInfo>;
}

export const RemoteControlRef = createToken<RemoteControlFace>('remote-control');

export interface CreateRemoteControlProps {
  readonly homeDir: string;
  readonly localOrigin: () => string;
  readonly localServerToken: () => string;
  readonly clientVersion: string;
  readonly relayOrigin?: string;
  readonly stderr?: Pick<NodeJS.WriteStream, 'write'>;
  readonly start?: (options: RemoteControlOptions) => Promise<RemoteControlHandle>;
}

export function createRemoteControl(props: CreateRemoteControlProps): FeatureSpec {
  return createFeature('remote-control', {
    app() {
      const node = useNode();
      const manager = createRemoteControlManager({
        homeDir: props.homeDir,
        localOrigin: props.localOrigin,
        localServerToken: props.localServerToken,
        clientVersion: props.clientVersion,
        relayOrigin: props.relayOrigin,
        stderr: props.stderr,
        start: props.start ?? startRemoteControl,
      });
      useExpose(RemoteControlRef, {
        status: () => manager.status(),
        enable: () => manager.enable(),
        disable: () => manager.disable(),
      });
      pushCleanup(node, () => manager.close());
    },
  });
}
