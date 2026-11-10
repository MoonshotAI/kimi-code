import type { IConfigService } from '@moonshot-ai/agent-core-v2';

import { HOSTS_SECTION, type HostEntry, type HostsSection } from './hostsConfig';
import { HostConnectError, SshKapBridge, type BridgeLogger, type HostEndpoint } from './sshKapBridge';

interface BridgeRecord {
  readonly fingerprint: string;
  readonly bridge: SshKapBridge;
}

export interface HostInfo {
  readonly id: string;
  readonly entry: HostEntry;
  readonly bridge: SshKapBridge | undefined;
}

export class HostBridgeManager {
  private readonly records = new Map<string, BridgeRecord>();
  private readonly subscription: { dispose(): void };

  constructor(
    private readonly config: Pick<IConfigService, 'ready' | 'get' | 'onDidSectionChange'>,
    private readonly logger: BridgeLogger,
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

  async connect(id: string): Promise<HostEndpoint> {
    await this.config.ready;
    const entry = this.section()[id];
    if (entry === undefined) throw new HostConnectError('unknown', `host "${id}" is not configured`);
    if (entry.enabled === false) throw new HostConnectError('unknown', `host "${id}" is disabled`);
    return this.record(id, entry).bridge.connect();
  }

  endpoint(id: string): HostEndpoint | undefined {
    return this.records.get(id)?.bridge.endpoint;
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
    const created = { fingerprint, bridge: new SshKapBridge(entry, { logger: this.logger }) };
    this.records.set(id, created);
    return created;
  }

  private reconcile(): void {
    const section = this.section();
    for (const [id, { fingerprint, bridge }] of this.records) {
      const entry = section[id];
      const next = entry === undefined ? undefined : JSON.stringify({ ...entry, enabled: undefined, name: undefined });
      if (next === fingerprint && entry?.enabled !== false) continue;
      bridge.dispose();
      this.records.delete(id);
    }
  }
}
