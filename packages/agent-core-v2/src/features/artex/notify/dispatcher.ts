import { matchesFilter, validateFilter } from './filter';
import { maskConfig } from './mask';
import { getNotifyChannel } from './registry';
import { redactUrlsInText } from './ssrf';
import {
  DEFAULT_MAX_ASSETS_SHOWN,
  DEFAULT_MAX_SUMMARY_RUNES,
  isPermanentNotificationError,
  type NotifyChannel,
  type NotifyChannelKind,
  type NotifyFilter,
  type NotifyItem,
  type NotifyLimits,
  type NotifyMessage,
  type NotifySnapshot,
  type NotifyTransportOptions,
} from './types';

export const NOTIFY_TICK_MS = 3_000;
export const NOTIFY_LEASE_MS = 180_000;
export const NOTIFY_SEND_TIMEOUT_MS = 30_000;
export const NOTIFY_DEFAULT_DIGEST_MINUTES = 30;
export const NOTIFY_SUMMARY_MAX_RUNES_CAP = 4000;
export const NOTIFY_ASSETS_MAX_SHOWN_CAP = 50;
export const NOTIFY_UNLIMITED_BURST_PER_TICK = 50;
export const NOTIFY_MAX_SENDS_PER_CHANNEL_PER_TICK = 5;
export const MAX_DIGEST_BATCH_SIZE = 500;
export const MAX_NOTIFY_ATTEMPTS = 3;

export const NOTIFY_BACKOFF_MS: readonly number[] = [1_000, 5_000, 30_000];

export type NotifyDeliveryMode = 'realtime' | 'digest';
export type NotifyDeliveryState = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface NotificationChannelConfig {
  readonly id: number;
  readonly name: string;
  readonly kind: NotifyChannelKind;
  readonly enabled: boolean;
  readonly mode: NotifyDeliveryMode;
  readonly config: Readonly<Record<string, unknown>>;
  readonly filter?: NotifyFilter;
  readonly ratePerMin?: number;
}

export interface MaskedNotificationChannel {
  readonly id: number;
  readonly name: string;
  readonly kind: NotifyChannelKind;
  readonly enabled: boolean;
  readonly mode: NotifyDeliveryMode;
  readonly config: Record<string, unknown>;
  readonly filter: NotifyFilter;
  readonly ratePerMin: number;
  readonly secretKeys: readonly string[];
}

export interface NotificationDeliveryRecord {
  readonly id: number;
  readonly channelId: number;
  readonly snapshot: NotifySnapshot;
  state: NotifyDeliveryState;
  attempts: number;
  lastError: string;
  batchId?: number;
  readonly createdAtMs: number;
  nextAttemptAtMs: number;
  sentAtMs?: number;
  leaseUntilMs?: number;
}

export interface ArtexNotificationDispatcherOptions {
  readonly enabled?: boolean;
  readonly publicBaseUrl?: string;
  readonly digestIntervalMinutes?: number;
  readonly limits?: Partial<NotifyLimits>;
  readonly tickMs?: number;
  readonly transport?: NotifyTransportOptions;
  readonly nowMs?: () => number;
  readonly resolveAssetNames?: (
    assetIds: readonly number[],
  ) => Promise<readonly string[]> | readonly string[];
  readonly logger?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

interface TokenBucket {
  tokens: number;
  lastFillMs: number;
}

export function clampNotifyLimit(
  value: number | undefined,
  defaultValue: number,
  maxValue: number,
): number {
  if (value === undefined || !Number.isInteger(value) || value < 0 || value > maxValue) {
    return defaultValue;
  }
  return value;
}

export function digestTickPlan(): { readonly tokens: number; readonly claimLimit: number } {
  return { tokens: 1, claimLimit: MAX_DIGEST_BATCH_SIZE };
}

function normalizeBaseUrl(url: string | undefined): string {
  if (url === undefined) return '';
  return url.trim().replace(/\/+$/, '');
}

export class ArtexNotificationDispatcher {
  private enabled: boolean;
  private publicBaseUrl: string;
  private digestIntervalMinutes: number;
  private limits: NotifyLimits;
  private readonly tickMs: number;
  private readonly transport: NotifyTransportOptions;
  private readonly nowMs: () => number;
  private readonly resolveAssetNames?: (
    assetIds: readonly number[],
  ) => Promise<readonly string[]> | readonly string[];
  private readonly logger?: (level: 'info' | 'warn' | 'error', message: string) => void;

  private readonly channels = new Map<number, NotificationChannelConfig>();
  private readonly deliveries: NotificationDeliveryRecord[] = [];
  private readonly buckets = new Map<number, TokenBucket>();
  private nextDeliveryId = 1;
  private nextBatchId = 1;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stepping = false;

  constructor(options: ArtexNotificationDispatcherOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.publicBaseUrl = normalizeBaseUrl(options.publicBaseUrl);
    this.digestIntervalMinutes =
      options.digestIntervalMinutes !== undefined && options.digestIntervalMinutes > 0
        ? options.digestIntervalMinutes
        : NOTIFY_DEFAULT_DIGEST_MINUTES;
    this.limits = {
      summaryRunes: clampNotifyLimit(
        options.limits?.summaryRunes,
        DEFAULT_MAX_SUMMARY_RUNES,
        NOTIFY_SUMMARY_MAX_RUNES_CAP,
      ),
      assetsShown: clampNotifyLimit(
        options.limits?.assetsShown,
        DEFAULT_MAX_ASSETS_SHOWN,
        NOTIFY_ASSETS_MAX_SHOWN_CAP,
      ),
    };
    this.tickMs = options.tickMs ?? NOTIFY_TICK_MS;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.transport = {
      timeoutMs: NOTIFY_SEND_TIMEOUT_MS,
      ...options.transport,
      nowMs: options.transport?.nowMs ?? this.nowMs,
    };
    this.resolveAssetNames = options.resolveAssetNames;
    this.logger = options.logger;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setPublicBaseUrl(url: string): void {
    this.publicBaseUrl = normalizeBaseUrl(url);
  }

  setDigestIntervalMinutes(minutes: number): void {
    if (Number.isFinite(minutes) && minutes > 0) {
      this.digestIntervalMinutes = minutes;
    }
  }

  setLimits(limits: Partial<NotifyLimits>): void {
    this.limits = {
      summaryRunes: clampNotifyLimit(
        limits.summaryRunes,
        DEFAULT_MAX_SUMMARY_RUNES,
        NOTIFY_SUMMARY_MAX_RUNES_CAP,
      ),
      assetsShown: clampNotifyLimit(
        limits.assetsShown,
        DEFAULT_MAX_ASSETS_SHOWN,
        NOTIFY_ASSETS_MAX_SHOWN_CAP,
      ),
    };
  }

  upsertChannel(channel: NotificationChannelConfig): void {
    const impl = getNotifyChannel(channel.kind);
    if (impl === undefined) {
      throw new Error(`channel type "${channel.kind}" is not registered`);
    }
    impl.validate(channel.config, this.transport);
    if (channel.filter !== undefined) {
      validateFilter(channel.filter);
    }
    if (channel.ratePerMin !== undefined && channel.ratePerMin < 0) {
      throw new Error('rate limit must not be negative');
    }
    const previous = this.channels.get(channel.id);
    this.channels.set(channel.id, {
      ...channel,
      ratePerMin: channel.ratePerMin ?? impl.defaultRatePerMin(),
    });
    if (previous !== undefined && previous.enabled && !channel.enabled) {
      this.skipPendingForChannel(channel.id);
    }
  }

  setChannelEnabled(channelId: number, enabled: boolean): boolean {
    const existing = this.channels.get(channelId);
    if (existing === undefined) return false;
    this.channels.set(channelId, { ...existing, enabled });
    if (!enabled) {
      this.skipPendingForChannel(channelId);
    }
    return true;
  }

  removeChannel(channelId: number): boolean {
    this.buckets.delete(channelId);
    return this.channels.delete(channelId);
  }

  listChannels(): MaskedNotificationChannel[] {
    const out: MaskedNotificationChannel[] = [];
    for (const ch of this.channels.values()) {
      const impl = getNotifyChannel(ch.kind);
      out.push({
        id: ch.id,
        name: ch.name,
        kind: ch.kind,
        enabled: ch.enabled,
        mode: ch.mode,
        config: maskConfig(ch.kind, ch.config),
        filter: ch.filter ?? {},
        ratePerMin: ch.ratePerMin ?? impl?.defaultRatePerMin() ?? 0,
        secretKeys: impl?.secretKeys() ?? [],
      });
    }
    return out;
  }

  listDeliveries(channelId?: number): readonly NotificationDeliveryRecord[] {
    if (channelId === undefined) return [...this.deliveries];
    return this.deliveries.filter((d) => d.channelId === channelId);
  }

  enqueue(snapshot: NotifySnapshot): readonly NotificationDeliveryRecord[] {
    const now = this.nowMs();
    const created: NotificationDeliveryRecord[] = [];
    for (const ch of this.channels.values()) {
      if (!ch.enabled) continue;
      const filter = ch.filter ?? {};
      if (!matchesFilter(filter, snapshot)) continue;
      const record: NotificationDeliveryRecord = {
        id: this.nextDeliveryId++,
        channelId: ch.id,
        snapshot,
        state: 'pending',
        attempts: 0,
        lastError: '',
        createdAtMs: now,
        nextAttemptAtMs: now,
      };
      this.deliveries.push(record);
      created.push(record);
    }
    return created;
  }

  async testChannel(channelId: number): Promise<number> {
    const ch = this.channels.get(channelId);
    if (ch === undefined) {
      throw new Error(`notification channel ${String(channelId)} does not exist`);
    }
    const impl = getNotifyChannel(ch.kind);
    if (impl === undefined) {
      throw new Error(`channel type "${ch.kind}" is not registered`);
    }
    impl.validate(ch.config, this.transport);
    const start = this.nowMs();
    const message: NotifyMessage = {
      items: [
        {
          findingId: 0,
          name: 'Test message · channel configuration OK',
          vulnclass: 'Connectivity test',
          severity: 'low',
          summary:
            'This is a test message for an ARTEX notification channel; receiving it means the channel is configured correctly.',
          assets: ['artex.example.com'],
          detailUrl: this.publicBaseUrl !== '' ? this.publicBaseUrl : undefined,
        },
      ],
      homeUrl: this.publicBaseUrl !== '' ? this.publicBaseUrl : undefined,
      limits: this.limits,
    };
    await impl.send(ch.config, message, this.transport);
    return Math.max(0, this.nowMs() - start);
  }

  takeTokens(channelId: number, ratePerMin: number, want: number, nowMs = this.nowMs()): number {
    if (want <= 0) return 0;
    if (ratePerMin <= 0) {
      return Math.min(want, NOTIFY_UNLIMITED_BURST_PER_TICK);
    }
    let bucket = this.buckets.get(channelId);
    if (bucket === undefined) {
      bucket = { tokens: ratePerMin, lastFillMs: nowMs };
      this.buckets.set(channelId, bucket);
    }
    const elapsedSec = (nowMs - bucket.lastFillMs) / 1000;
    if (elapsedSec > 0) {
      bucket.tokens = Math.min(ratePerMin, bucket.tokens + (elapsedSec * ratePerMin) / 60);
      bucket.lastFillMs = nowMs;
    }
    const take = Math.min(Math.floor(bucket.tokens + 1e-9), want);
    if (take <= 0) return 0;
    bucket.tokens -= take;
    return take;
  }

  async step(nowMs = this.nowMs()): Promise<void> {
    if (!this.enabled || this.stepping) return;
    this.stepping = true;
    try {
      for (const ch of this.channels.values()) {
        if (!ch.enabled) continue;
        const ratePerMin = ch.ratePerMin ?? getNotifyChannel(ch.kind)?.defaultRatePerMin() ?? 0;
        if (ch.mode === 'digest') {
          const plan = digestTickPlan();
          if (!this.isDigestDue(ch.id, nowMs)) continue;
          if (this.takeTokens(ch.id, ratePerMin, plan.tokens, nowMs) <= 0) continue;
          await this.deliverDigest(ch, plan.claimLimit, nowMs);
          continue;
        }
        const allow = this.takeTokens(ch.id, ratePerMin, NOTIFY_MAX_SENDS_PER_CHANNEL_PER_TICK, nowMs);
        if (allow <= 0) continue;
        await this.deliverRealtime(ch, allow, nowMs);
      }
    } finally {
      this.stepping = false;
    }
  }

  async flushDigest(channelId: number, nowMs = this.nowMs()): Promise<void> {
    const ch = this.channels.get(channelId);
    if (ch === undefined || !ch.enabled) return;
    await this.deliverDigest(ch, MAX_DIGEST_BATCH_SIZE, nowMs);
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.step();
    }, this.tickMs);
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.stop();
  }

  private skipPendingForChannel(channelId: number): void {
    for (const dl of this.deliveries) {
      if (dl.channelId === channelId && dl.state === 'pending') {
        dl.state = 'skipped';
      }
    }
  }

  private claimPending(channelId: number, limit: number, nowMs: number, batchId?: number): NotificationDeliveryRecord[] {
    const claimed: NotificationDeliveryRecord[] = [];
    for (const dl of this.deliveries) {
      if (claimed.length >= limit) break;
      if (dl.channelId !== channelId) continue;
      const leaseExpired = dl.state === 'sending' && (dl.leaseUntilMs ?? 0) <= nowMs;
      const duePending = dl.state === 'pending' && dl.nextAttemptAtMs <= nowMs;
      if (!duePending && !leaseExpired) continue;
      dl.state = 'sending';
      dl.attempts += 1;
      dl.leaseUntilMs = nowMs + NOTIFY_LEASE_MS;
      if (batchId !== undefined) dl.batchId = batchId;
      claimed.push(dl);
    }
    return claimed;
  }

  private isDigestDue(channelId: number, nowMs: number): boolean {
    const windowMs = this.digestIntervalMinutes * 60_000;
    let oldestPendingMs: number | undefined;
    for (const dl of this.deliveries) {
      if (dl.channelId !== channelId) continue;
      if (dl.state !== 'pending' || dl.nextAttemptAtMs > nowMs) continue;
      if (oldestPendingMs === undefined || dl.createdAtMs < oldestPendingMs) {
        oldestPendingMs = dl.createdAtMs;
      }
    }
    if (oldestPendingMs === undefined) return false;
    return nowMs - oldestPendingMs >= windowMs;
  }

  private async deliverRealtime(
    ch: NotificationChannelConfig,
    allow: number,
    nowMs: number,
  ): Promise<void> {
    const claimed = this.claimPending(ch.id, allow, nowMs);
    if (claimed.length === 0) return;

    const impl = getNotifyChannel(ch.kind);
    if (impl === undefined) {
      this.failDeliveries(claimed, `channel type "${ch.kind}" is not registered`);
      return;
    }

    for (const dl of claimed) {
      const item = await this.itemFor(dl.snapshot);
      const message: NotifyMessage = {
        items: [item],
        homeUrl: this.publicBaseUrl !== '' ? this.publicBaseUrl : undefined,
        limits: this.limits,
      };
      await this.sendAndRecord(impl, ch, message, [dl], nowMs);
    }
  }

  private async deliverDigest(
    ch: NotificationChannelConfig,
    claimLimit: number,
    nowMs: number,
  ): Promise<void> {
    const batchId = this.nextBatchId++;
    const claimed = this.claimPending(ch.id, claimLimit, nowMs, batchId);
    if (claimed.length === 0) return;

    const impl = getNotifyChannel(ch.kind);
    if (impl === undefined) {
      this.failDeliveries(claimed, `channel type "${ch.kind}" is not registered`);
      return;
    }

    const items: NotifyItem[] = [];
    for (const dl of claimed) {
      items.push(await this.itemFor(dl.snapshot));
    }

    const message: NotifyMessage = {
      items,
      batch: true,
      windowMinutes: this.digestIntervalMinutes,
      homeUrl: this.publicBaseUrl !== '' ? this.publicBaseUrl : undefined,
      limits: this.limits,
    };

    await this.sendAndRecord(impl, ch, message, claimed, nowMs);
  }

  private async sendAndRecord(
    impl: NotifyChannel,
    ch: NotificationChannelConfig,
    message: NotifyMessage,
    deliveries: readonly NotificationDeliveryRecord[],
    nowMs: number,
  ): Promise<void> {
    let delivered = 0;
    try {
      delivered = await impl.send(ch.config, message, this.transport);
    } catch (error) {
      const safeMsg = redactUrlsInText(error instanceof Error ? error.message : String(error));
      const permanent = isPermanentNotificationError(error);
      for (const dl of deliveries) {
        dl.leaseUntilMs = undefined;
        if (permanent) {
          dl.state = 'failed';
          dl.lastError = safeMsg;
        } else if (dl.attempts >= MAX_NOTIFY_ATTEMPTS) {
          dl.state = 'failed';
          dl.lastError = `still failing after ${String(MAX_NOTIFY_ATTEMPTS)} retries: ${safeMsg}`;
        } else {
          const delayIdx = Math.min(dl.attempts, NOTIFY_BACKOFF_MS.length - 1);
          dl.state = 'pending';
          dl.lastError = safeMsg;
          dl.nextAttemptAtMs = nowMs + (NOTIFY_BACKOFF_MS[delayIdx] ?? 30_000);
        }
      }
      this.log(
        'warn',
        `[notify] delivery failed channel=${String(ch.id)} kind=${ch.kind} permanent=${String(permanent)}: ${safeMsg}`,
      );
      return;
    }

    if (delivered <= 0) {
      const safeMsg = `channel did not report a delivered count (delivered=${String(delivered)})`;
      for (const dl of deliveries) {
        dl.leaseUntilMs = undefined;
        if (dl.attempts >= MAX_NOTIFY_ATTEMPTS) {
          dl.state = 'failed';
          dl.lastError = safeMsg;
        } else {
          dl.state = 'pending';
          dl.lastError = safeMsg;
          dl.nextAttemptAtMs = nowMs + (NOTIFY_BACKOFF_MS[Math.min(dl.attempts, NOTIFY_BACKOFF_MS.length - 1)] ?? 30_000);
        }
      }
      return;
    }

    const clampedDelivered = Math.min(delivered, deliveries.length);
    const sent = deliveries.slice(0, clampedDelivered);
    const rest = deliveries.slice(clampedDelivered);

    for (const dl of sent) {
      dl.state = 'sent';
      dl.sentAtMs = nowMs;
      dl.leaseUntilMs = undefined;
      dl.lastError = '';
    }
    for (const dl of rest) {
      // Segmentation is not a failure: undo optimistic attempt increment and defer.
      dl.state = 'pending';
      dl.attempts = Math.max(0, dl.attempts - 1);
      dl.leaseUntilMs = undefined;
      dl.nextAttemptAtMs = nowMs;
      dl.lastError = `this message reached the channel length limit; only the first ${String(clampedDelivered)} entries were delivered, the rest are left for the next batch`;
    }
  }

  private failDeliveries(deliveries: readonly NotificationDeliveryRecord[], reason: string): void {
    const safeMsg = redactUrlsInText(reason);
    for (const dl of deliveries) {
      dl.state = 'failed';
      dl.leaseUntilMs = undefined;
      dl.lastError = safeMsg;
    }
  }

  private async itemFor(snapshot: NotifySnapshot): Promise<NotifyItem> {
    let assets: readonly string[] = [];
    if (this.resolveAssetNames !== undefined && snapshot.assetIds.length > 0) {
      try {
        assets = await this.resolveAssetNames(snapshot.assetIds);
      } catch (error) {
        this.log(
          'warn',
          `[notify] failed to resolve asset names finding=${String(snapshot.findingId)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return {
      findingId: snapshot.findingId,
      name: snapshot.name,
      vulnclass: snapshot.vulnclass,
      severity: snapshot.severity,
      summary: snapshot.summary,
      assets,
      detailUrl:
        this.publicBaseUrl !== ''
          ? `${this.publicBaseUrl}/function/findings/detail?id=${String(snapshot.findingId)}`
          : undefined,
      fromStatus: snapshot.fromStatus,
      toStatus: snapshot.toStatus,
    };
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    if (this.logger !== undefined) {
      this.logger(level, redactUrlsInText(message));
    }
  }
}
