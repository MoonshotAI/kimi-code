import { setTimeout as sleep } from 'node:timers/promises';

import {
  DEVICES_SECTION,
  IConfigService,
  type DeviceEntry,
  type DevicesSection,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import type { DeviceSnapshot } from '../../protocol/events-zod';
import { AccountDeviceBridge, type RemoteControlRelay } from './accountDeviceBridge';
import { DeviceConnectError, type DeviceBridge, type DeviceUpgradeResult } from './deviceBridge';
import type { DeviceSources } from './deviceFanout';
import {
  collectSharedProviders,
  sendSharedProviders,
  type ProviderCopyResult,
} from './deviceProviders';
import type { DeviceSession } from './deviceSession';
import { SshDeviceBridge } from './sshDeviceBridge';

const DEVICE_RESUME_TIMEOUT_MS = 2_000;

interface BridgeRecord {
  readonly fingerprint: string;
  readonly bridge: DeviceBridge;
  started: boolean;
}

export type DeviceConflict =
  | { readonly failure: 'self' }
  | { readonly failure: 'duplicate'; readonly duplicateOf: string };

export interface DeviceInfo {
  readonly id: string;
  readonly entry: DeviceEntry;
  readonly bridge: DeviceBridge | undefined;
  readonly conflict?: DeviceConflict;
}

export interface DeviceManagerOptions {
  readonly relay: RemoteControlRelay;
  readonly localDeviceId: string;
  readonly upgradeTimeoutMs?: number;
  readonly onChange?: () => void;
}

function machineId(info: Omit<DeviceInfo, 'conflict'>): string | undefined {
  return info.bridge?.identity?.deviceId ?? (info.entry.connection === 'account' ? info.id : undefined);
}

function conflictMessage(id: string, conflict: DeviceConflict): string {
  return conflict.failure === 'self'
    ? `device "${id}" is this computer`
    : `device "${id}" is the same computer as device "${conflict.duplicateOf}"`;
}

export function toDeviceSnapshot(info: DeviceInfo): DeviceSnapshot {
  const { id, entry, bridge, conflict } = info;
  const disabled = entry.enabled === false;
  const ssh = entry.connection === 'account' ? undefined : entry;
  const account = bridge instanceof AccountDeviceBridge ? bridge : undefined;
  const registration = account?.registration;
  return {
    id,
    connection: entry.connection ?? 'ssh',
    host: ssh?.host,
    identity_file: ssh?.identityFile,
    remote_bin: ssh?.remoteBin,
    name: entry.name,
    enabled: entry.enabled,
    status: disabled || conflict !== undefined ? 'disconnected' : bridge?.status ?? 'pending',
    remote_version: bridge?.remoteVersion,
    connect_error: disabled
      ? `device "${id}" is disabled`
      : conflict === undefined ? bridge?.error : conflictMessage(id, conflict),
    connect_failure: disabled ? 'unknown' : conflict?.failure ?? bridge?.failure,
    device_id: machineId(info),
    product_name: bridge?.identity?.productName,
    platform: registration?.platform,
    alias: registration?.alias,
    duplicate_of: conflict?.failure === 'duplicate' ? conflict.duplicateOf : undefined,
    install: ssh === undefined ? account?.install : 'cli',
    remote_upgrade: ssh === undefined ? account?.remoteUpgrade : true,
    upgrade_status: bridge?.upgradeState?.status,
    upgrade_error: bridge?.upgradeState?.error,
  };
}

export function deviceSnapshots(manager: DeviceManager): DeviceSnapshot[] {
  return manager.list().map(toDeviceSnapshot);
}

export function deviceSources(manager: DeviceManager): DeviceSources {
  return {
    sources: () => {
      manager.activate();
      return manager
        .list()
        .filter((info) => info.conflict === undefined)
        .map((info) => ({
          id: info.id,
          getSession: async () => (info.entry.enabled === false ? undefined : currentSession(info.bridge)),
        }));
    },
  };
}

async function currentSession(bridge: DeviceBridge | undefined): Promise<DeviceSession | undefined> {
  const session = bridge?.session;
  if (session !== undefined) return session;
  const resuming = bridge?.resumeIfIdle?.();
  if (resuming === undefined) return undefined;
  const deadline = new AbortController();
  try {
    return await Promise.race([
      resuming,
      sleep(DEVICE_RESUME_TIMEOUT_MS, undefined, { signal: deadline.signal, ref: false }),
    ]);
  } catch {
    return undefined;
  } finally {
    deadline.abort();
  }
}

export class DeviceManager {
  private readonly records = new Map<string, BridgeRecord>();
  private readonly subscription: { dispose(): void };
  private active = false;

  constructor(
    private readonly core: Scope,
    private readonly options: DeviceManagerOptions,
  ) {
    this.subscription = core.accessor.get(IConfigService).onDidSectionChange((event) => {
      if (event.domain === DEVICES_SECTION) this.reconcile();
    });
  }

  section(): DevicesSection {
    return this.core.accessor.get(IConfigService).get<DevicesSection | undefined>(DEVICES_SECTION) ?? {};
  }

  list(): readonly DeviceInfo[] {
    const infos = Object.entries(this.section()).map(([id, entry]) => ({
      id,
      entry,
      bridge: this.records.get(id)?.bridge,
    }));
    const owners = new Map<string, string>();
    return infos.map((info): DeviceInfo => {
      const machine = info.entry.enabled === false ? undefined : machineId(info);
      if (machine === undefined) return info;
      if (machine === this.options.localDeviceId) return { ...info, conflict: { failure: 'self' } };
      const owner = owners.get(machine);
      if (owner !== undefined) return { ...info, conflict: { failure: 'duplicate', duplicateOf: owner } };
      owners.set(machine, info.id);
      return info;
    });
  }

  accountDeviceRejection(id: string): string | undefined {
    if (id === this.options.localDeviceId) return 'this device cannot be added to itself';
    if (this.section()[id] !== undefined) return undefined;
    const existing = this.list().find((info) => info.id !== id && machineId(info) === id);
    return existing === undefined ? undefined : `this device is already added as device "${existing.id}"`;
  }

  async connect(id: string): Promise<DeviceSession> {
    const record = await this.usableRecord(id);
    const session = await record.bridge.connect();
    this.assertUsable(id);
    return session;
  }

  async upgrade(id: string): Promise<DeviceUpgradeResult> {
    const record = await this.usableRecord(id);
    return record.bridge.upgrade();
  }

  activate(): void {
    if (this.active) return;
    this.active = true;
    void this.core.accessor.get(IConfigService).ready.then(() => {
      this.startPending();
    });
  }

  async copyProviders(id: string): Promise<ProviderCopyResult> {
    if (this.section()[id]?.connection === 'account') {
      throw new Error('Copying model providers is only available for SSH devices');
    }
    const session = await this.connect(id);
    const shared = await collectSharedProviders(this.core);
    if (Object.keys(shared.providers).length === 0) return { providers: [] };
    return sendSharedProviders(session, shared);
  }

  session(id: string): DeviceSession | undefined {
    return this.conflictOf(id) === undefined ? this.records.get(id)?.bridge.session : undefined;
  }

  close(): void {
    this.active = false;
    this.subscription.dispose();
    for (const { bridge } of this.records.values()) bridge.dispose();
    this.records.clear();
  }

  private conflictOf(id: string): DeviceConflict | undefined {
    return this.list().find((info) => info.id === id)?.conflict;
  }

  private assertUsable(id: string): void {
    const conflict = this.conflictOf(id);
    if (conflict !== undefined) throw new DeviceConnectError(conflict.failure, conflictMessage(id, conflict));
  }

  private async usableRecord(id: string): Promise<BridgeRecord> {
    await this.core.accessor.get(IConfigService).ready;
    const entry = this.section()[id];
    if (entry === undefined) throw new DeviceConnectError('unknown', `device "${id}" is not configured`);
    if (entry.enabled === false) throw new DeviceConnectError('unknown', `device "${id}" is disabled`);
    const record = this.record(id, entry);
    this.assertUsable(id);
    record.started = true;
    return record;
  }

  private record(id: string, entry: DeviceEntry): BridgeRecord {
    const fingerprint = JSON.stringify({ ...entry, enabled: undefined, name: undefined });
    const existing = this.records.get(id);
    if (existing?.fingerprint === fingerprint) return existing;
    existing?.bridge.dispose();
    const created = { fingerprint, bridge: this.createBridge(id, entry), started: false };
    this.records.set(id, created);
    this.options.onChange?.();
    return created;
  }

  private createBridge(id: string, entry: DeviceEntry): DeviceBridge {
    const options = { upgradeTimeoutMs: this.options.upgradeTimeoutMs, onChange: (): void => this.options.onChange?.() };
    return entry.connection === 'account'
      ? new AccountDeviceBridge(id, this.options.relay, options)
      : new SshDeviceBridge(entry, options);
  }

  private reconcile(): void {
    const section = this.section();
    let changed = false;
    for (const [id, { fingerprint, bridge }] of this.records) {
      const entry = section[id];
      const next = entry === undefined ? undefined : JSON.stringify({ ...entry, enabled: undefined, name: undefined });
      if (next === fingerprint && entry?.enabled !== false) continue;
      this.records.delete(id);
      changed = true;
      bridge.dispose();
    }
    if (changed) this.options.onChange?.();
    this.startPending();
  }

  private startPending(): void {
    if (!this.active) return;
    for (const [id, entry] of Object.entries(this.section())) {
      if (entry.enabled === false) continue;
      const record = this.record(id, entry);
      if (record.started || this.conflictOf(id) !== undefined) continue;
      record.started = true;
      record.bridge.start();
    }
  }
}
