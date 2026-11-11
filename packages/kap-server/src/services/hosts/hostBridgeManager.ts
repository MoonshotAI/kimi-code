import { IConfigService, type Scope } from '@moonshot-ai/agent-core-v2';

import { localHostCredential, localHostCredentialKey, saveLocalHostCredential, type HostCredential, type HostCredentialOffer } from './hostAuth';
import { HOSTS_SECTION, type HostEntry, type HostsSection } from './hostsConfig';
import { HostConnectError, SshKapBridge, type BridgeLogger, type HostStatus } from './sshKapBridge';
import type { HostSession } from './hostSession';

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

export function toHostSnapshot(id: string, entry: HostEntry, bridge: SshKapBridge | undefined): HostSnapshot {
  return {
    id,
    host: entry.host,
    identity_file: entry.identityFile,
    remote_bin: entry.remoteBin,
    name: entry.name,
    enabled: entry.enabled,
    status: entry.enabled === false ? 'disconnected' : bridge?.status ?? 'pending',
    connected: entry.enabled !== false && bridge?.session !== undefined,
    remote_version: bridge?.remoteVersion,
    connect_error: entry.enabled === false ? `host "${id}" is disabled` : bridge?.error,
    connect_failure: entry.enabled === false ? 'unknown' : bridge?.failure,
  };
}

export function hostSnapshots(manager: HostBridgeManager): HostSnapshot[] {
  const configured = manager.configured();
  return configured === undefined ? [] : [toHostSnapshot(configured.id, configured.entry, manager.bridge())];
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

  configured(): { id: string; entry: HostEntry } | undefined {
    const section = this.core.accessor.get(IConfigService).get<HostsSection | undefined>(HOSTS_SECTION) ?? {};
    const id = Object.keys(section)[0];
    const entry = id === undefined ? undefined : section[id];
    return entry === undefined || id === undefined ? undefined : { id, entry };
  }

  bridge(): SshKapBridge | undefined {
    const id = this.configured()?.id;
    return id === undefined ? undefined : this.records.get(id)?.bridge;
  }

  session(id: string): HostSession | undefined {
    return this.configured()?.id === id ? this.bridge()?.session : undefined;
  }

  async connect(id = this.configured()?.id): Promise<HostSession> {
    await this.core.accessor.get(IConfigService).ready;
    const selected = this.configured();
    if (id !== selected?.id) throw new HostConnectError('unknown', `unknown host "${id ?? ''}"`);
    if (selected === undefined) throw new HostConnectError('unknown', 'no SSH host is configured');
    if (selected.entry.enabled === false) throw new HostConnectError('unknown', `host "${selected.id}" is disabled`);
    const bridge = this.record(selected.id, selected.entry).bridge;
    const credential = await localHostCredential(this.core);
    const offer: HostCredentialOffer = credential === undefined
      ? { type: 'auth', action: 'logout', oauth_key: await localHostCredentialKey(this.core) }
      : { type: 'auth', action: 'provision', credential };
    const session = await bridge.connect(offer);
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
    const selected = this.configured();
    for (const [id, { fingerprint, bridge }] of this.records) {
      const next = selected?.id === id ? JSON.stringify({ ...selected.entry, enabled: undefined, name: undefined }) : undefined;
      if (next === fingerprint && selected?.entry.enabled !== false) continue;
      bridge.dispose();
      this.records.delete(id);
    }
    this.onChange?.();
  }
}

interface BridgeRecord {
  readonly fingerprint: string;
  readonly bridge: SshKapBridge;
}
