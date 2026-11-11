import { IConfigService, type Scope } from '@moonshot-ai/agent-core-v2';

import { localHostCredential, localHostCredentialKey, saveLocalHostCredential, type HostCredential, type HostCredentialOffer } from './hostAuth';
import { HOSTS_SECTION, type HostEntry, type HostsSection } from './hostsConfig';
import { HostConnectError, SshKapBridge, type BridgeLogger, type HostStatus } from './sshKapBridge';
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

export interface HostSnapshot {
  readonly id: string;
  readonly host: string;
  readonly identity_file?: string;
  readonly remote_bin?: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly status: HostStatus;
  readonly connected: boolean;
  readonly remote_version?: string;
  readonly connect_error?: string;
  readonly connect_failure?: string;
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
    connected: !disabled && info.bridge?.session !== undefined,
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

  constructor(
    private readonly core: Scope,
    private readonly logger: BridgeLogger,
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

  async connect(id = Object.keys(this.section())[0]): Promise<HostSession> {
    await this.core.accessor.get(IConfigService).ready;
    const entry = id === undefined ? undefined : this.section()[id];
    if (entry === undefined || id === undefined) throw new HostConnectError('unknown', `host "${id ?? ''}" is not configured`);
    if (entry.enabled === false) throw new HostConnectError('unknown', `host "${id}" is disabled`);
    const credential = await localHostCredential(this.core);
    const offer: HostCredentialOffer = credential === undefined
      ? { type: 'auth', action: 'logout', oauth_key: await localHostCredentialKey(this.core) }
      : { type: 'auth', action: 'provision', credential };
    const session = await this.record(id, entry).bridge.connect(offer);
    const remote = await this.credential(session, offer.action === 'logout'
      ? { action: 'logout', oauth_key: offer.oauth_key }
      : { action: 'provision', credential: offer.credential });
    if (remote !== null) await saveLocalHostCredential(this.core, remote);
    return session;
  }

  async refreshCredential(): Promise<HostCredential> {
    await this.connect();
    const credential = await localHostCredential(this.core);
    if (credential === undefined) throw new Error('The account is not available on this host');
    return credential;
  }

  private async credential(session: HostSession, input: Record<string, unknown>): Promise<HostCredential | null> {
    const response = await session.request({
      method: 'POST',
      path: '/api/v1/oauth/host-credential',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(input)),
      timeoutMs: 60_000,
    });
    const body = JSON.parse(response.body.toString('utf8')) as {
      code?: number;
      msg?: string;
      data?: { credential?: HostCredential | null };
    };
    if (response.status !== 200 || body.code !== 0 || body.data === undefined) {
      throw new Error(body.msg ?? 'Unable to synchronize the account with the SSH host');
    }
    return body.data.credential ?? null;
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
