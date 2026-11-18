import {
  RemoteControlDeviceClientError,
  RemoteControlLoginRequiredError,
  type RemoteControlDevice,
  type RemoteControlDeviceClient,
} from '@moonshot-ai/remote-control';

import {
  DeviceConnectError,
  readRemoteMeta,
  type DeviceBridge,
  type DeviceConnectFailure,
  type DeviceStatus,
  type RemoteDeviceIdentity,
} from './deviceBridge';
import { DeviceRequestError, type DeviceSession } from './deviceSession';
import { RelayDeviceSession } from './relayDeviceSession';

export type RemoteControlRelay = Pick<RemoteControlDeviceClient, 'listDevices' | 'relayAccess'>;

export interface AccountDeviceBridgeOptions {
  readonly onChange?: () => void;
}

const FIRST_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;
const OUTDATED_POLL_MS = 60_000;
const RETRYABLE: ReadonlySet<DeviceConnectFailure> = new Set(['offline', 'relay_unavailable', 'unknown']);

function relayError(error: unknown): DeviceConnectError {
  const message = error instanceof Error ? error.message : String(error);
  const rejected = error instanceof RemoteControlDeviceClientError && (error.status === 401 || error.status === 403);
  return new DeviceConnectError(
    error instanceof RemoteControlLoginRequiredError || rejected ? 'signed_out' : 'relay_unavailable',
    message,
  );
}

function outdatedError(version: string | undefined): DeviceConnectError {
  return new DeviceConnectError(
    'outdated',
    `Kimi Code ${version ?? '(unknown version)'} on this device is too old for this app; update Kimi Code on the device`,
    version,
  );
}

export class AccountDeviceBridge implements DeviceBridge {
  private statusValue: DeviceStatus = 'pending';
  private failureValue: DeviceConnectFailure | undefined;
  private errorValue: string | undefined;
  private remoteVersionValue: string | undefined;
  private identityValue: RemoteDeviceIdentity;
  private registrationValue: RemoteControlDevice | undefined;
  private sessionValue: RelayDeviceSession | undefined;
  private connecting: Promise<DeviceSession> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 0;
  private disposed = false;

  constructor(
    private readonly deviceId: string,
    private readonly relay: RemoteControlRelay,
    private readonly options: AccountDeviceBridgeOptions = {},
  ) {
    this.identityValue = { deviceId };
  }

  get status(): DeviceStatus {
    return this.statusValue;
  }

  get failure(): DeviceConnectFailure | undefined {
    return this.failureValue;
  }

  get error(): string | undefined {
    return this.errorValue;
  }

  get remoteVersion(): string | undefined {
    return this.remoteVersionValue;
  }

  get session(): DeviceSession | undefined {
    return this.sessionValue;
  }

  get identity(): RemoteDeviceIdentity {
    return this.identityValue;
  }

  get registration(): RemoteControlDevice | undefined {
    return this.registrationValue;
  }

  connect(): Promise<DeviceSession> {
    if (this.disposed) return Promise.reject(new DeviceConnectError('unknown', 'device bridge disposed'));
    if (this.sessionValue !== undefined) return Promise.resolve(this.sessionValue);
    this.connecting ??= this.establish().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  start(): void {
    void this.connect().catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    this.sessionValue?.close();
    this.sessionValue = undefined;
  }

  private async establish(): Promise<DeviceSession> {
    clearTimeout(this.retryTimer);
    if (this.statusValue !== 'ready') this.update('connecting');
    try {
      const session = await this.openSession();
      this.sessionValue = session;
      this.retryDelay = 0;
      this.update('ready');
      return session;
    } catch (error) {
      const failure = error instanceof DeviceConnectError
        ? error
        : new DeviceConnectError('unknown', error instanceof Error ? error.message : String(error));
      if (failure.remoteVersion !== undefined) this.remoteVersionValue = failure.remoteVersion;
      if (!this.disposed) {
        this.update('disconnected', failure.failure, failure.message);
        this.scheduleRetry(failure.failure);
      }
      throw failure;
    }
  }

  private async openSession(): Promise<RelayDeviceSession> {
    const devices = await this.reachRelay();
    this.assertActive();
    const registration = devices.find((device) => device.device_id === this.deviceId);
    this.registrationValue = registration;
    if (registration === undefined) {
      throw new DeviceConnectError('offline', 'this device is not registered for Remote Control under this Kimi account');
    }
    if (registration.status !== 'online') {
      throw new DeviceConnectError('offline', `"${registration.alias}" is offline`);
    }
    const session: RelayDeviceSession = new RelayDeviceSession(this.deviceId, this.relay, () => {
      this.onTransportFailure(session);
    });
    try {
      const meta = await readRemoteMeta(session);
      this.assertActive();
      if (meta.identity === undefined) throw outdatedError(meta.serverVersion);
      this.identityValue = meta.identity;
      this.remoteVersionValue = meta.serverVersion;
      return session;
    } catch (error) {
      session.close();
      if (error instanceof DeviceRequestError) throw new DeviceConnectError('offline', error.message);
      throw error;
    }
  }

  private async reachRelay(): Promise<readonly RemoteControlDevice[]> {
    try {
      await this.relay.relayAccess();
      const { devices } = await this.relay.listDevices();
      return devices;
    } catch (error) {
      throw relayError(error);
    }
  }

  private onTransportFailure(session: RelayDeviceSession): void {
    if (this.disposed || this.sessionValue !== session) return;
    this.sessionValue = undefined;
    session.close();
    this.update('connecting');
    this.scheduleRetry('unknown');
  }

  private scheduleRetry(failure: DeviceConnectFailure): void {
    clearTimeout(this.retryTimer);
    const delay = this.nextRetryDelay(failure);
    if (delay === undefined) return;
    this.retryTimer = setTimeout(() => {
      this.start();
    }, delay);
    this.retryTimer.unref?.();
  }

  private nextRetryDelay(failure: DeviceConnectFailure): number | undefined {
    if (failure === 'outdated') return OUTDATED_POLL_MS;
    if (!RETRYABLE.has(failure)) return undefined;
    this.retryDelay = Math.min(Math.max(this.retryDelay * 2, FIRST_RETRY_DELAY_MS), MAX_RETRY_DELAY_MS);
    return this.retryDelay;
  }

  private assertActive(): void {
    if (this.disposed) throw new DeviceConnectError('unknown', 'device bridge disposed');
  }

  private update(status: DeviceStatus, failure?: DeviceConnectFailure, error?: string): void {
    this.statusValue = status;
    this.failureValue = failure;
    this.errorValue = error;
    this.options.onChange?.();
  }
}
