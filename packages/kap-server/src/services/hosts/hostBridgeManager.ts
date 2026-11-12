import { IConfigService, type Scope } from '@moonshot-ai/agent-core-v2';

import { localHostCredential, type HostCredentialUpdate } from './hostAuth';
import { collectSharedProviders, sendSharedProviders, type ProviderCopyResult } from './hostProviders';
import { HOSTS_SECTION, type HostEntry, type HostsSection } from './hostsConfig';
import { HostConnectError, SshKapBridge, type BridgeLogger, type HostStatus } from './sshKapBridge';
import type { HostSession } from './hostSession';

const MIN_CREDENTIAL_DELAY_MS = 30_000;
const CREDENTIAL_RETRY_SECONDS = 60;

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
  private credentialQueue: Promise<void> = Promise.resolve();
  private credentialTimer: ReturnType<typeof setTimeout> | undefined;
  private active = false;

  constructor(
    private readonly core: Scope,
    private readonly logger: BridgeLogger,
    private readonly onChange?: () => void,
  ) {
    this.subscription = core.accessor.get(IConfigService).onDidSectionChange((event) => {
      if (event.domain === HOSTS_SECTION) this.reconcile();
      if (event.domain === 'providers') void this.syncCredentials();
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

  syncCredentials(): Promise<void> {
    return this.serialize(async () => {
      const sessions = [...this.records.values()]
        .map(({ bridge }) => bridge.session)
        .filter((session): session is HostSession => session !== undefined);
      if (sessions.length === 0) {
        this.schedule(undefined);
        return;
      }
      const update = await this.currentUpdate();
      await Promise.all(sessions.map((session) => this.sendQuietly(session, update)));
    });
  }

  async copyProviders(id: string, only?: readonly string[]): Promise<ProviderCopyResult> {
    const session = await this.connect(id);
    const { shared, skipped } = await collectSharedProviders(this.core, only);
    if (Object.keys(shared.providers).length === 0) return { copied: [], updated: [], skipped };
    const result = await sendSharedProviders(session, shared);
    return { copied: result.copied, updated: result.updated, skipped: [...skipped, ...result.skipped] };
  }

  session(id: string): HostSession | undefined {
    return this.records.get(id)?.bridge.session;
  }

  close(): void {
    this.active = false;
    this.subscription.dispose();
    this.schedule(undefined);
    for (const { bridge } of this.records.values()) bridge.dispose();
    this.records.clear();
  }

  private provision(session: HostSession): Promise<void> {
    return this.serialize(async () => {
      await this.sendQuietly(session, await this.currentUpdate());
    });
  }

  private serialize(task: () => Promise<void>): Promise<void> {
    const next = this.credentialQueue.then(task).catch((error: unknown) => {
      this.logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'unable to share the account with SSH hosts');
    });
    this.credentialQueue = next;
    return next;
  }

  private async currentUpdate(): Promise<HostCredentialUpdate> {
    let local: Awaited<ReturnType<typeof localHostCredential>>;
    try {
      local = await localHostCredential(this.core);
    } catch (error) {
      this.schedule(Math.floor(Date.now() / 1000) + CREDENTIAL_RETRY_SECONDS);
      throw error;
    }
    this.schedule(local?.refreshAt);
    return local === undefined ? { action: 'revoke' } : { action: 'put', credential: local.credential };
  }

  private schedule(refreshAt: number | undefined): void {
    if (this.credentialTimer !== undefined) clearTimeout(this.credentialTimer);
    this.credentialTimer = undefined;
    if (refreshAt === undefined) return;
    const delay = Math.max(MIN_CREDENTIAL_DELAY_MS, refreshAt * 1000 - Date.now());
    this.credentialTimer = setTimeout(() => {
      this.credentialTimer = undefined;
      void this.syncCredentials();
    }, delay);
    this.credentialTimer.unref?.();
  }

  private async sendQuietly(session: HostSession, update: HostCredentialUpdate): Promise<void> {
    try {
      await sendHostCredentialUpdate(session, update);
    } catch (error) {
      this.logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'unable to share the account with an SSH host');
    }
  }

  private record(id: string, entry: HostEntry): BridgeRecord {
    const fingerprint = JSON.stringify({ ...entry, enabled: undefined, name: undefined });
    const existing = this.records.get(id);
    if (existing?.fingerprint === fingerprint) return existing;
    existing?.bridge.dispose();
    const created = {
      fingerprint,
      bridge: new SshKapBridge(entry, {
        logger: this.logger,
        onChange: () => this.onChange?.(),
        onSession: (session) => this.provision(session),
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
      const session = bridge.session;
      if (entry === undefined && session !== undefined) {
        void this.sendQuietly(session, { action: 'revoke' }).finally(() => {
          bridge.dispose();
        });
      } else {
        bridge.dispose();
      }
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

export async function sendHostCredentialUpdate(session: HostSession, update: HostCredentialUpdate): Promise<void> {
  const response = await session.request({
    method: 'POST',
    path: '/api/v1/oauth/host-credential',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(update)),
    timeoutMs: 60_000,
  });
  const body = JSON.parse(response.body.toString('utf8')) as { code?: number; msg?: string };
  if (response.status !== 200 || body.code !== 0) {
    throw new Error(body.msg ?? 'Unable to share the account with the SSH host');
  }
}
