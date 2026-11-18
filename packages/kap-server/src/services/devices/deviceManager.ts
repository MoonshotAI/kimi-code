import {
  DEVICES_SECTION,
  IConfigService,
  type DeviceEntry,
  type DevicesSection,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import type { DeviceSnapshot } from '../../protocol/events-zod';
import {
  collectSharedProviders,
  sendSharedProviders,
  type ProviderCopyResult,
} from './deviceProviders';
import { DeviceConnectError, SshDeviceBridge } from './sshDeviceBridge';
import type { DeviceSession } from './deviceSession';

interface BridgeRecord {
  readonly fingerprint: string;
  readonly bridge: SshDeviceBridge;
}

export interface DeviceInfo {
  readonly id: string;
  readonly entry: DeviceEntry;
  readonly bridge: SshDeviceBridge | undefined;
}

export function toDeviceSnapshot(info: DeviceInfo): DeviceSnapshot {
  const disabled = info.entry.enabled === false;
  return {
    id: info.id,
    host: info.entry.host,
    identity_file: info.entry.identityFile,
    remote_bin: info.entry.remoteBin,
    name: info.entry.name,
    enabled: info.entry.enabled,
    status: disabled ? 'disconnected' : info.bridge?.status ?? 'pending',
    remote_version: info.bridge?.remoteVersion,
    connect_error: disabled ? `device "${info.id}" is disabled` : info.bridge?.error,
    connect_failure: disabled ? 'unknown' : info.bridge?.failure,
  };
}

export function deviceSnapshots(manager: DeviceManager): DeviceSnapshot[] {
  return manager.list().map(toDeviceSnapshot);
}

export class DeviceManager {
  private readonly records = new Map<string, BridgeRecord>();
  private readonly subscription: { dispose(): void };
  private active = false;

  constructor(
    private readonly core: Scope,
    private readonly onChange?: () => void,
  ) {
    this.subscription = core.accessor.get(IConfigService).onDidSectionChange((event) => {
      if (event.domain === DEVICES_SECTION) this.reconcile();
    });
  }

  section(): DevicesSection {
    return this.core.accessor.get(IConfigService).get<DevicesSection | undefined>(DEVICES_SECTION) ?? {};
  }

  list(): readonly DeviceInfo[] {
    return Object.entries(this.section()).map(([id, entry]) => ({
      id,
      entry,
      bridge: this.records.get(id)?.bridge,
    }));
  }

  async connect(id: string): Promise<DeviceSession> {
    await this.core.accessor.get(IConfigService).ready;
    const entry = this.section()[id];
    if (entry === undefined) throw new DeviceConnectError('unknown', `device "${id}" is not configured`);
    if (entry.enabled === false) throw new DeviceConnectError('unknown', `device "${id}" is disabled`);
    return this.record(id, entry).bridge.connect();
  }

  activate(): void {
    if (this.active) return;
    this.active = true;
    void this.core.accessor.get(IConfigService).ready.then(() => {
      this.startPending();
    });
  }

  async copyProviders(id: string): Promise<ProviderCopyResult> {
    const session = await this.connect(id);
    const shared = await collectSharedProviders(this.core);
    if (Object.keys(shared.providers).length === 0) return { providers: [] };
    return sendSharedProviders(session, shared);
  }

  session(id: string): DeviceSession | undefined {
    return this.records.get(id)?.bridge.session;
  }

  close(): void {
    this.active = false;
    this.subscription.dispose();
    for (const { bridge } of this.records.values()) bridge.dispose();
    this.records.clear();
  }

  private record(id: string, entry: DeviceEntry): BridgeRecord {
    const fingerprint = JSON.stringify({ ...entry, enabled: undefined, name: undefined });
    const existing = this.records.get(id);
    if (existing?.fingerprint === fingerprint) return existing;
    existing?.bridge.dispose();
    const created = {
      fingerprint,
      bridge: new SshDeviceBridge(entry, {
        onChange: () => this.onChange?.(),
      }),
    };
    this.records.set(id, created);
    this.onChange?.();
    return created;
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
    if (changed) this.onChange?.();
    this.startPending();
  }

  private startPending(): void {
    if (!this.active) return;
    for (const [id, entry] of Object.entries(this.section())) {
      if (entry.enabled === false || this.records.has(id)) continue;
      this.record(id, entry).bridge.start();
    }
  }
}
