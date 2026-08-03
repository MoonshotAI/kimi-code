/**
 * `remoteControl` domain — App-scope device tunnel lifecycle contract.
 */

import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { RemoteDisconnectReason } from './protocol';

export type RemoteControlState = 'disabled' | 'offline' | 'connecting' | 'online';

export interface RemoteControlStartOptions {
  readonly relayBaseUrl: string;
  readonly localBaseUrl: string;
  readonly alias: string;
  readonly getLocalToken: () => string;
  /** Stream setup deadline in milliseconds. Defaults to 10 seconds; tests may lower it. */
  readonly streamOpenTimeoutMs?: number;
}

export interface IRemoteControlService {
  readonly _serviceBrand: undefined;
  readonly state: RemoteControlState;
  readonly onDidChangeState: Event<RemoteControlState>;
  start(options: RemoteControlStartOptions): Promise<void>;
  stop(reason: Extract<RemoteDisconnectReason, 'user_requested' | 'local_server_stopped' | 'client_upgrading'>): Promise<void>;
}

export const IRemoteControlService: ServiceIdentifier<IRemoteControlService> =
  createDecorator<IRemoteControlService>('remoteControlService');
