import { setTimeout as sleep } from 'node:timers/promises';

import {
  RemoteControlDeviceClientError,
  RemoteControlLoginRequiredError,
  type RemoteControlDevice,
  type RemoteControlDeviceClient,
} from '@moonshot-ai/remote-control';

import {
  DEFAULT_UPGRADE_TIMEOUT_MS,
  DeviceBridgeState,
  DeviceConnectError,
  DeviceUpgradeInProgressError,
  isUpgrading,
  readRemoteMeta,
  upgradeTimeoutError,
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
  readonly upgradeTimeoutMs?: number;
  readonly onChange?: () => void;
}

const FIRST_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;
const OUTDATED_POLL_MS = 60_000;
const FIRST_UPGRADE_POLL_MS = 1000;
const MAX_UPGRADE_POLL_MS = 15_000;
const EXPIRED_UPGRADE_POLL_MS = 60_000;
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

export class AccountDeviceBridge extends DeviceBridgeState implements DeviceBridge {
  private identityValue: RemoteDeviceIdentity;
  private registrationValue: RemoteControlDevice | undefined;
  private remoteUpgradeValue: boolean | undefined;
  private upgradeFrom: string | undefined;
  private upgradeRequested = false;
  private upgradeAttempt = 0;
  private upgradeTimer: ReturnType<typeof setTimeout> | undefined;
  private upgradeTimedOut = false;
  private sessionValue: RelayDeviceSession | undefined;
  private connecting: Promise<DeviceSession> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 0;
  private readonly upgradeTimeoutMs: number;

  constructor(
    private readonly deviceId: string,
    private readonly relay: RemoteControlRelay,
    private readonly options: AccountDeviceBridgeOptions = {},
  ) {
    super();
    this.identityValue = { deviceId };
    this.upgradeTimeoutMs = options.upgradeTimeoutMs ?? DEFAULT_UPGRADE_TIMEOUT_MS;
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

  connect(): Promise<DeviceSession> {
    if (this.disposed) return this.rejectDisposed();
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
    clearTimeout(this.upgradeTimer);
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
    const attempt = this.beginUpgrade();
    void this.followUpgrade(upgradeSession, attempt).finally(() => {
      upgradeSession.close();
    });
    return { status: 'started' };
  }

  private beginUpgrade(): number {
    this.upgradeAttempt += 1;
    this.upgradeTimedOut = false;
    this.setUpgrade({ status: 'installing' });
    clearTimeout(this.upgradeTimer);
    this.upgradeTimer = setTimeout(() => {
      if (!isUpgrading(this.upgradeValue)) return;
      this.upgradeTimedOut = true;
      this.setUpgrade({ status: 'failed', error: upgradeTimeoutError(this.upgradeTimeoutMs) });
    }, this.upgradeTimeoutMs);
    this.upgradeTimer.unref?.();
    return this.upgradeAttempt;
  }

  private async followUpgrade(session: DeviceSession, attempt: number): Promise<void> {
    for (
      let delay = FIRST_UPGRADE_POLL_MS;
      this.followsUpgrade(attempt);
      delay = Math.min(delay * 2, this.upgradeTimedOut ? EXPIRED_UPGRADE_POLL_MS : MAX_UPGRADE_POLL_MS)
    ) {
      await sleep(delay, undefined, { ref: false });
      if (this.followsUpgrade(attempt)) await this.pollUpgrade(session).catch(() => undefined);
    }
  }

  private followsUpgrade(attempt: number): boolean {
    return !this.disposed && attempt === this.upgradeAttempt && (isUpgrading(this.upgradeValue) || this.upgradeTimedOut);
  }

  private async pollUpgrade(session: DeviceSession): Promise<void> {
    await this.refresh(session);
    if (this.upgradeValue === undefined) {
      if (this.sessionValue === undefined) this.start();
      return;
    }
    if (!isUpgrading(this.upgradeValue)) return;
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
      this.upgradeTimedOut = false;
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
    if (!isUpgrading(state)) clearTimeout(this.upgradeTimer);
    this.options.onChange?.();
  }

  private update(status: DeviceStatus, failure?: DeviceConnectFailure, error?: string): void {
    this.statusValue = status;
    this.failureValue = failure;
    this.errorValue = error;
    this.options.onChange?.();
  }
}
