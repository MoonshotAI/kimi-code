import { getNotifyChannel } from './registry';

export const MASKED_PREFIX = '__masked__';

export function maskedValue(secret: string): string {
  if (secret.length <= 6) return MASKED_PREFIX;
  return `${MASKED_PREFIX}:…${secret.slice(-6)}`;
}

export function isMasked(value: string): boolean {
  return value.startsWith(MASKED_PREFIX);
}

export function maskConfig(
  kind: string,
  cfg: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const channel = getNotifyChannel(kind);
  if (channel === undefined) return {};
  const secrets = new Set(channel.secretKeys());
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (!secrets.has(k)) {
      out[k] = v;
      continue;
    }
    out[k] = typeof v === 'string' ? maskedValue(v) : MASKED_PREFIX;
  }
  return out;
}

export class DestinationChangedWithoutCredentialsError extends Error {
  readonly changed: readonly string[];
  readonly missing: readonly string[];

  constructor(changed: readonly string[], missing: readonly string[]) {
    super(
      `destination address (${changed.join(', ')}) has changed; please also re-fill the credential fields (${missing.join(', ')}): enter a new value, or explicitly leave it empty to indicate the credential is no longer needed. The original credential is only valid for the old address; continuing to use it amounts to handing it to the new address.`,
    );
    this.name = 'DestinationChangedWithoutCredentialsError';
    this.changed = changed;
    this.missing = missing;
  }
}

export function mergeConfig(
  stored: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...stored };
  for (const [k, v] of Object.entries(incoming)) {
    if (typeof v === 'string') {
      if (isMasked(v)) continue;
      if (v.trim() === '') {
        delete out[k];
        continue;
      }
      out[k] = v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function isBlankConfigValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim() === '';
}

function stableJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function sameConfigValue(a: unknown, b: unknown): boolean {
  if (isBlankConfigValue(a) && isBlankConfigValue(b)) return true;
  const ra = stableJson(a);
  const rb = stableJson(b);
  return ra !== undefined && rb !== undefined && ra === rb;
}

function rejectMaskedInContainers(
  incoming: Readonly<Record<string, unknown>>,
  secretKeys: readonly string[],
): void {
  for (const key of secretKeys) {
    if (!(key in incoming)) continue;
    const raw = incoming[key];
    if (typeof raw === 'string') continue;
    const encoded = stableJson(raw);
    if (encoded !== undefined && encoded.includes(MASKED_PREFIX)) {
      throw new Error(
        `field ${key} contains the masking marker "${MASKED_PREFIX}": this field can only be left empty as a whole to keep the original, or submitted as a whole with a new value; embedding a masking placeholder inside a structure is not allowed`,
      );
    }
  }
}

export function prepareConfigUpdate(
  kind: string,
  stored: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const channel = getNotifyChannel(kind);
  if (channel === undefined) {
    throw new Error(`channel kind "${kind}" is not registered`);
  }
  const secrets = channel.secretKeys();
  const destinations = channel.destinationKeys();

  rejectMaskedInContainers(incoming, secrets);

  const changed: string[] = [];
  for (const key of destinations) {
    if (!(key in incoming)) continue;
    const raw = incoming[key];
    if (typeof raw === 'string' && isMasked(raw)) continue;
    if (!sameConfigValue(raw, stored[key])) {
      changed.push(key);
    }
  }

  if (changed.length === 0) {
    return mergeConfig(stored, incoming);
  }

  const missing: string[] = [];
  for (const key of secrets) {
    if (!(key in incoming)) {
      missing.push(key);
      continue;
    }
    const raw = incoming[key];
    if (typeof raw === 'string' && isMasked(raw)) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new DestinationChangedWithoutCredentialsError(changed, missing);
  }
  return mergeConfig(stored, incoming);
}
