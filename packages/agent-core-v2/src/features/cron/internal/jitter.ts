import type { ParsedCronExpression } from './cron-expr';
import { computeNextCronRun } from './cron-expr';

export interface JitterConfig {
  readonly recurringMaxFractionOfPeriod: number;
  readonly recurringMaxMs: number;
  readonly oneShotMaxMs: number;
}

export const DEFAULT_CRON_JITTER_CONFIG: JitterConfig = {
  recurringMaxFractionOfPeriod: 0.1,
  recurringMaxMs: 15 * 60_000,
  oneShotMaxMs: 90_000,
};

const MS_PER_DAY = 24 * 60 * 60_000;
const MS_PER_MINUTE = 60_000;

function fractionFromId(id: string): number {
  if (/^[0-9a-f]{8}$/i.test(id)) {
    const n = Number.parseInt(id, 16);
    if (Number.isFinite(n)) {
      return n / 0x1_0000_0000;
    }
  }
  let hash = 5381;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) + hash + id.charCodeAt(i)) | 0;
  }
  const unsigned = hash >>> 0;
  return unsigned / 0x1_0000_0000;
}

function jitterDisabled(noJitter: boolean | undefined): boolean {
  return noJitter === true;
}

export function jitteredNextCronRunMs(
  task: { id: string; cron: string; recurring?: boolean },
  parsed: ParsedCronExpression,
  idealMs: number,
  config: JitterConfig = DEFAULT_CRON_JITTER_CONFIG,
  noJitter?: boolean,
): number {
  if (jitterDisabled(noJitter)) {
    return idealMs;
  }
  const nextNext = computeNextCronRun(parsed, idealMs);
  const period =
    nextNext !== null && nextNext > idealMs ? nextNext - idealMs : MS_PER_DAY;
  const periodCap = period * config.recurringMaxFractionOfPeriod;
  const cap = Math.min(periodCap, config.recurringMaxMs);
  if (!(cap > 0)) {
    return idealMs;
  }
  const offset = cap * fractionFromId(task.id);
  return idealMs + offset;
}

export function oneShotJitteredNextCronRunMs(
  task: { id: string; createdAt?: number | undefined },
  idealMs: number,
  config: JitterConfig = DEFAULT_CRON_JITTER_CONFIG,
  noJitter?: boolean,
): number {
  if (jitterDisabled(noJitter)) {
    return idealMs;
  }
  if (idealMs % MS_PER_MINUTE !== 0) {
    return idealMs;
  }
  const minuteOfHour = new Date(idealMs).getMinutes();
  if (minuteOfHour !== 0 && minuteOfHour !== 30) {
    return idealMs;
  }
  if (!(config.oneShotMaxMs > 0)) {
    return idealMs;
  }
  const offset = -config.oneShotMaxMs * fractionFromId(task.id);
  const shifted = idealMs + offset;
  if (task.createdAt !== undefined && shifted < task.createdAt) {
    return idealMs;
  }
  return shifted;
}
