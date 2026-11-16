export type NotifyChannelKind =
  | 'dingtalk'
  | 'feishu'
  | 'wecom'
  | 'webhook'
  | 'telegram'
  | 'email';

export const NOTIFY_CHANNEL_KINDS: readonly NotifyChannelKind[] = [
  'dingtalk',
  'email',
  'feishu',
  'telegram',
  'webhook',
  'wecom',
];

export type NotifyEventKind = 'finding_created' | 'finding_status_changed';

export const EVENT_FINDING_CREATED: NotifyEventKind = 'finding_created';
export const EVENT_FINDING_STATUS_CHANGED: NotifyEventKind = 'finding_status_changed';

export const DEFAULT_MAX_ASSETS_SHOWN = 3;
export const DEFAULT_MAX_SUMMARY_RUNES = 120;
export const ALLOW_LOCAL_TARGETS_ENV = 'ARTEX_NOTIFY_ALLOW_LOCAL';

export interface NotifySnapshot {
  readonly kind: NotifyEventKind;
  readonly findingId: number;
  readonly taskId: number;
  readonly vulnclass: string;
  readonly name: string;
  readonly severity: string;
  readonly summary: string;
  readonly assetIds: readonly number[];
  readonly fromStatus?: string;
  readonly toStatus?: string;
}

export interface NotifyItem {
  readonly findingId: number;
  readonly name: string;
  readonly vulnclass: string;
  readonly severity: string;
  readonly summary: string;
  readonly assets: readonly string[];
  readonly detailUrl?: string;
  readonly fromStatus?: string;
  readonly toStatus?: string;
}

export interface NotifyLimits {
  readonly summaryRunes: number;
  readonly assetsShown: number;
}

export interface NotifyMessage {
  readonly items: readonly NotifyItem[];
  readonly batch?: boolean;
  readonly windowMinutes?: number;
  readonly homeUrl?: string;
  readonly limits?: NotifyLimits;
}

export interface NotifyFilter {
  readonly minSeverity?: string;
  readonly taskIds?: readonly number[];
  readonly assetIds?: readonly number[];
  readonly includeCategories?: readonly string[];
  readonly excludeCategories?: readonly string[];
  readonly onStatusChange?: boolean;
}

export type NotifyDnsLookup = (
  hostname: string,
) => Promise<readonly { readonly address: string; readonly family: 4 | 6 }[]>;

export interface NotifyTransportOptions {
  readonly allowPrivateTargets?: boolean;
  readonly timeoutMs?: number;
  readonly dnsLookup?: NotifyDnsLookup;
  readonly nowMs?: () => number;
}

export interface NotifyChannel {
  readonly kind: NotifyChannelKind;
  validate(cfg: Readonly<Record<string, unknown>>, options?: NotifyTransportOptions): void;
  send(
    cfg: Readonly<Record<string, unknown>>,
    message: NotifyMessage,
    options?: NotifyTransportOptions,
  ): Promise<number>;
  defaultRatePerMin(): number;
  secretKeys(): readonly string[];
  destinationKeys(): readonly string[];
}

export class PermanentNotificationError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PermanentNotificationError';
    this.cause = cause;
  }
}

export function permanentError(err: unknown): PermanentNotificationError {
  if (err instanceof PermanentNotificationError) return err;
  if (err instanceof Error) return new PermanentNotificationError(err.message, err);
  return new PermanentNotificationError(String(err), err);
}

export function isPermanentNotificationError(err: unknown): boolean {
  return err instanceof PermanentNotificationError;
}

const SEVERITY_RANK_MAP: Readonly<Record<string, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function severityRank(severity: string): number {
  return SEVERITY_RANK_MAP[severity] ?? 0;
}

export function severityLabel(severity: string): string {
  switch (severity) {
    case 'critical':
      return '🔴 Critical';
    case 'high':
      return '🟠 High';
    case 'medium':
      return '🟡 Medium';
    case 'low':
      return '🔵 Low';
    default:
      return severity;
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'in_progress':
      return 'In progress';
    case 'confirmed':
      return 'Confirmed';
    case 'resolved':
      return 'Resolved';
    case 'fixed':
      return 'Fixed';
    case 'false_positive':
      return 'False positive';
    case 'ignored':
      return 'Ignored';
    case 'duplicate':
      return 'Duplicate';
    case 'risk_accepted':
      return 'Risk accepted';
    default:
      return status;
  }
}

export function atLeastSeverity(severity: string, min: string): boolean {
  if (min === '') return true;
  return severityRank(severity) >= severityRank(min);
}

export function isStatusChangeItem(item: NotifyItem): boolean {
  return (item.fromStatus ?? '') !== '' || (item.toStatus ?? '') !== '';
}

export function notifyItemTitle(item: NotifyItem): string {
  if (item.name !== '') return item.name;
  if (item.vulnclass !== '') return item.vulnclass;
  return '(unnamed vulnerability)';
}

export function messageLimits(message: NotifyMessage): NotifyLimits {
  return message.limits ?? {
    summaryRunes: DEFAULT_MAX_SUMMARY_RUNES,
    assetsShown: DEFAULT_MAX_ASSETS_SHOWN,
  };
}

export function cfgString(cfg: Readonly<Record<string, unknown>>, key: string): string {
  const value = cfg[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function cfgInt(cfg: Readonly<Record<string, unknown>>, key: string): number {
  const value = cfg[key];
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return 0;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function cfgBool(cfg: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = cfg[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'yes';
  }
  return false;
}

export function cfgStrings(cfg: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = cfg[key];
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed !== '') out.push(trimmed);
    }
    return out;
  }
  const single = cfgString(cfg, key);
  return single !== '' ? [single] : [];
}

export function cfgMap(
  cfg: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, string> | undefined {
  const value = cfg[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
    const k = rawKey.trim();
    if (k === '' || typeof rawVal !== 'string') continue;
    out[k] = rawVal;
  }
  return out;
}
