import { setTimeout as sleep } from 'node:timers/promises';

import {
  RemoteControlDeviceClientError,
  RemoteControlLoginRequiredError,
  type RemoteControlDevice,
  type RemoteControlDeviceClient,
} from '@moonshot-ai/remote-control';

import {
  DeviceConnectError,
  DeviceUpgradeInProgressError,
  isUpgrading,
  readRemoteMeta,
  type DeviceBridge,
  type DeviceConnectFailure,
  type DeviceInstall,
  type DeviceStatus,
  type DeviceUpgradeResult,
  type DeviceUpgradeState,
  type RemoteDeviceIdentity,
  type RemoteDeviceMeta,
} from './deviceBridge';
import { DeviceRequestError, type DeviceSession } from './deviceSession';
import { readSystemUpgrade, startSystemUpgrade } from './deviceUpgrade';
import { RelayDeviceSession } from './relayDeviceSession';

export type RemoteControlRelay = Pick<RemoteControlDeviceClient, 'listDevices' | 'relayAccess'>;

export interface AccountDeviceBridgeOptions {
  readonly onChange?: () => void;
}

const FIRST_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;
const OUTDATED_POLL_MS = 60_000;
const FIRST_UPGRADE_POLL_MS = 1000;
const MAX_UPGRADE_POLL_MS = 15_000;
const RETRYABLE: ReadonlySet<DeviceConnectFailure> = new Set(['offline', 'relay_unavailable', 'unknown']);
const DESKTOP_PRODUCT = 'kimi-code-desktop';

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

function installOf(product: string | undefined): DeviceInstall | undefined {
  if (product === undefined || product.length === 0) return undefined;
  return product === DESKTOP_PRODUCT ? 'desktop' : 'cli';
}

export class AccountDeviceBridge implements DeviceBridge {
  private statusValue: DeviceStatus = 'pending';
  private failureValue: DeviceConnectFailure | undefined;
  private errorValue: string | undefined;
  private remoteVersionValue: string | undefined;
  private identityValue: RemoteDeviceIdentity;
  private registrationValue: RemoteControlDevice | undefined;
  private remoteUpgradeValue: boolean | undefined;
  private upgradeValue: DeviceUpgradeState | undefined;
  private upgradeFrom: string | undefined;
  private upgradeRequested = false;
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

  get install(): DeviceInstall | undefined {
    return installOf(this.identityValue.productName ?? this.registrationValue?.client_version.split('/', 1)[0]);
  }

  get remoteUpgrade(): boolean | undefined {
    return this.install === 'desktop' ? false : this.remoteUpgradeValue;
  }

  get upgradeState(): DeviceUpgradeState | undefined {
    return this.upgradeValue;
  }

  connect(): Promise<DeviceSession> {
    if (this.disposed) return Promise.reject(new DeviceConnectError('unknown', 'device bridge disposed'));
    if (this.sessionValue !== undefined) return Promise.resolve(this.sessionValue);
    this.connecting ??= this.establish().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async upgrade(): Promise<DeviceUpgradeResult> {
    if (this.upgradeRequested || isUpgrading(this.upgradeValue)) throw new DeviceUpgradeInProgressError();
    this.upgradeRequested = true;
    try {
      return await this.requestUpgrade();
    } finally {
      this.upgradeRequested = false;
    }
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

  private async requestUpgrade(): Promise<DeviceUpgradeResult> {
    const session = await this.connect().catch((error: unknown) => {
      if (this.install === 'desktop' || (error instanceof DeviceConnectError && error.failure === 'outdated')) return undefined;
      throw error;
    });
    if (session !== undefined) await this.refresh(session);
    if (this.install === 'desktop') {
      return { status: 'update_on_device', message: 'this device runs the Kimi Code desktop app; update it on that computer' };
    }
    if (this.remoteUpgradeValue !== true) {
      return {
        status: 'unsupported',
        message: `Kimi Code ${this.remoteVersionValue ?? '(unknown version)'} on this device cannot be upgraded remotely; run \`kimi upgrade\` on the device`,
      };
    }
    const upgradeSession = new RelayDeviceSession(this.deviceId, this.relay);
    try {
      await startSystemUpgrade(upgradeSession);
    } catch (error) {
      upgradeSession.close();
      throw error;
    }
    this.upgradeFrom = this.remoteVersionValue;
    this.setUpgrade({ status: 'installing' });
    void this.followUpgrade(upgradeSession).finally(() => {
      upgradeSession.close();
    });
    return { status: 'started' };
  }

  private async followUpgrade(session: DeviceSession): Promise<void> {
    for (
      let delay = FIRST_UPGRADE_POLL_MS;
      isUpgrading(this.upgradeValue) && !this.disposed;
      delay = Math.min(delay * 2, MAX_UPGRADE_POLL_MS)
    ) {
      await sleep(delay, undefined, { ref: false });
      if (isUpgrading(this.upgradeValue) && !this.disposed) await this.pollUpgrade(session).catch(() => undefined);
    }
  }

  private async pollUpgrade(session: DeviceSession): Promise<void> {
    await this.refresh(session);
    if (!isUpgrading(this.upgradeValue)) {
      if (this.sessionValue === undefined) this.start();
      return;
    }
    const remote = await readSystemUpgrade(session);
    if (!isUpgrading(this.upgradeValue)) return;
    switch (remote.state) {
      case 'installing':
      case 'restarting':
        if (this.upgradeValue?.status !== remote.state) this.setUpgrade({ status: remote.state });
        return;
      case 'failed':
        this.setUpgrade({ status: 'failed', error: remote.message ?? 'the upgrade failed on the device' });
        return;
      case 'idle':
        await this.refresh(session);
        if (isUpgrading(this.upgradeValue)) {
          this.setUpgrade({
            status: 'failed',
            error: `the device restarted still on Kimi Code ${this.remoteVersionValue ?? '(unknown version)'}; try again`,
          });
        }
    }
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
      const meta = await this.refresh(session);
      if (meta.identity === undefined) throw outdatedError(meta.serverVersion);
      return session;
    } catch (error) {
      session.close();
      if (error instanceof DeviceRequestError) throw new DeviceConnectError('offline', error.message);
      throw error;
    }
  }

  private async refresh(session: DeviceSession): Promise<RemoteDeviceMeta> {
    const meta = await readRemoteMeta(session);
    this.assertActive();
    this.remoteUpgradeValue = meta.systemUpgrade;
    if (meta.identity !== undefined) this.identityValue = meta.identity;
    if (meta.serverVersion !== undefined) this.remoteVersionValue = meta.serverVersion;
    if (this.upgradeFrom !== undefined && meta.serverVersion !== undefined && meta.serverVersion !== this.upgradeFrom) {
      this.upgradeFrom = undefined;
      this.setUpgrade(undefined);
    }
    return meta;
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

  private setUpgrade(state: DeviceUpgradeState | undefined): void {
    this.upgradeValue = state;
    this.options.onChange?.();
  }

  private update(status: DeviceStatus, failure?: DeviceConnectFailure, error?: string): void {
    this.statusValue = status;
    this.failureValue = failure;
    this.errorValue = error;
    this.options.onChange?.();
  }
}
