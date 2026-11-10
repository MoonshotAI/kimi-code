import type { IConfigService } from '@moonshot-ai/agent-core-v2';

import { HOSTS_SECTION, type HostEntry, type HostsSection } from './hostsConfig';
import {
  HostConnectError,
  SshKapBridge,
  type BridgeLogger,
  type HostSession,
  type HostStatus,
} from './sshKapBridge';

interface BridgeRecord {
  readonly fingerprint: string;
  readonly bridge: SshKapBridge;
}

export interface HostInfo {
  readonly id: string;
  readonly entry: HostEntry;
  readonly bridge: SshKapBridge | undefined;
}

export interface HostSnapshot {
  readonly id: string;
  readonly host: string;
  readonly identity_file?: string;
  readonly remote_bin?: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly status: HostStatus;
  readonly remote_version?: string;
  readonly connect_error?: string;
  readonly connect_failure?: string;
}

export function toHostSnapshot(info: HostInfo): HostSnapshot {
  return {
    id: info.id,
    host: info.entry.host,
    identity_file: info.entry.identityFile,
    remote_bin: info.entry.remoteBin,
    name: info.entry.name,
    enabled: info.entry.enabled,
    status: info.bridge?.status ?? 'pending',
    remote_version: info.bridge?.remoteVersion,
    connect_error: info.bridge?.error,
    connect_failure: info.bridge?.failure,
  };
}

export function hostSnapshots(manager: HostBridgeManager): HostSnapshot[] {
  return manager.list().map(toHostSnapshot);
}

export class HostBridgeManager {
  private readonly records = new Map<string, BridgeRecord>();
  private readonly subscription: { dispose(): void };

  constructor(
    private readonly config: Pick<IConfigService, 'ready' | 'get' | 'onDidSectionChange'>,
    private readonly logger: BridgeLogger,
    private readonly onChange?: () => void,
  ) {
    this.subscription = config.onDidSectionChange((event) => {
      if (event.domain === HOSTS_SECTION) this.reconcile();
    });
  }

  section(): HostsSection {
    return this.config.get<HostsSection | undefined>(HOSTS_SECTION) ?? {};
  }

  list(): readonly HostInfo[] {
    return Object.entries(this.section()).map(([id, entry]) => ({
      id,
      entry,
      bridge: this.records.get(id)?.bridge,
    }));
  }

  async connect(id: string): Promise<HostSession> {
    await this.config.ready;
    const entry = this.section()[id];
    if (entry === undefined) throw new HostConnectError('unknown', `host "${id}" is not configured`);
    if (entry.enabled === false) throw new HostConnectError('unknown', `host "${id}" is disabled`);
    return this.record(id, entry).bridge.connect();
  }

  session(id: string): HostSession | undefined {
    return this.records.get(id)?.bridge.session;
  }

  close(): void {
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
      bridge: new SshKapBridge(entry, { logger: this.logger, onChange: () => this.onChange?.() }),
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
      bridge.dispose();
      this.records.delete(id);
      changed = true;
    }
    if (changed) this.onChange?.();
  }
}
