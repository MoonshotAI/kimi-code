import { IConfigService, type Scope } from '@moonshot-ai/agent-core-v2';

import type { HostSnapshot } from '../../protocol/events-zod';
import {
  collectSharedProviders,
  sendSharedProviders,
  type ProviderCopyResult,
} from './hostProviders';
import { HOSTS_SECTION, type HostEntry, type HostsSection } from './hostsConfig';
import { HostConnectError, SshKapBridge } from './sshKapBridge';
import type { HostSession } from './hostSession';

interface BridgeRecord {
  readonly fingerprint: string;
  readonly bridge: SshKapBridge;
}

export interface HostInfo {
  readonly id: string;
  readonly entry: HostEntry;
  readonly bridge: SshKapBridge | undefined;
}

export function toHostSnapshot(info: HostInfo): HostSnapshot {
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
    connect_error: disabled ? `host "${info.id}" is disabled` : info.bridge?.error,
    connect_failure: disabled ? 'unknown' : info.bridge?.failure,
  };
}

export function hostSnapshots(manager: HostBridgeManager): HostSnapshot[] {
  return manager.list().map(toHostSnapshot);
}

export class HostBridgeManager {
  private readonly records = new Map<string, BridgeRecord>();
  private readonly subscription: { dispose(): void };
  private active = false;

  constructor(
    private readonly core: Scope,
    private readonly onChange?: () => void,
  ) {
    this.subscription = core.accessor.get(IConfigService).onDidSectionChange((event) => {
      if (event.domain === HOSTS_SECTION) this.reconcile();
    });
  }

  section(): HostsSection {
    return this.core.accessor.get(IConfigService).get<HostsSection | undefined>(HOSTS_SECTION) ?? {};
  }

  list(): readonly HostInfo[] {
    return Object.entries(this.section()).map(([id, entry]) => ({
      id,
      entry,
      bridge: this.records.get(id)?.bridge,
    }));
  }

  async connect(id: string): Promise<HostSession> {
    await this.core.accessor.get(IConfigService).ready;
    const entry = this.section()[id];
    if (entry === undefined) throw new HostConnectError('unknown', `host "${id}" is not configured`);
    if (entry.enabled === false) throw new HostConnectError('unknown', `host "${id}" is disabled`);
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
    if (Object.keys(shared.providers).length === 0) return { copied: [], updated: [] };
    return sendSharedProviders(session, shared);
  }

  session(id: string): HostSession | undefined {
    return this.records.get(id)?.bridge.session;
  }

  close(): void {
    this.active = false;
    this.subscription.dispose();
    for (const { bridge } of this.records.values()) bridge.dispose();
    this.records.clear();
  }

  private record(id: string, entry: HostEntry): BridgeRecord {
    const fingerprint = JSON.stringify({ ...entry, enabled: undefined, name: undefined });
    const existing = this.records.get(id);
    if (existing?.fingerprint === fingerprint) return existing;
    existing?.bridge.dispose();
    const created = {
      fingerprint,
      bridge: new SshKapBridge(entry, {
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
