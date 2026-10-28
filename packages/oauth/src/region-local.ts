import type { KimiRegion } from './region';

export interface LocalRegionSignals {
  readonly timeZone?: string;
  readonly locale?: string;
}

export interface LocalRegionDetection {
  readonly region: KimiRegion;
  readonly confident: boolean;
}

export function collectLocalRegionSignals(): LocalRegionSignals {
  try {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    return { timeZone: resolved.timeZone, locale: resolved.locale };
  } catch {
    return {};
  }
}

const CN_TIME_ZONES = new Set(['Asia/Shanghai', 'Asia/Urumqi']);
const UNINFORMATIVE_TIME_ZONES = new Set([
  'UTC',
  'Etc/UTC',
  'Etc/Universal',
  'Etc/Zulu',
  'Universal',
  'Zulu',
  'GMT',
  'Etc/GMT',
  'Etc/GMT0',
  'Etc/GMT+0',
  'Etc/GMT-0',
  'GMT0',
  'GMT+0',
  'GMT-0',
  'Greenwich',
  'Etc/Greenwich',
  'Etc/Unknown',
  'Factory',
  'Etc/Factory',
]);
const UNINFORMATIVE_TIME_ZONE_PATTERNS = [
  /^Etc\/GMT[+-]\d{1,2}$/,
  /^[+-]\d{2}:?\d{2}$/,
  /^[A-Za-z]{2,5}[+-]\d{1,2}(?::\d{2})?$/,
];

type SignalVote = 'cn' | 'non-cn' | 'none';

function timeZoneVote(timeZone: string | undefined): SignalVote {
  if (timeZone === undefined || timeZone.length === 0) return 'none';
  if (CN_TIME_ZONES.has(timeZone)) return 'cn';
  if (UNINFORMATIVE_TIME_ZONES.has(timeZone)) return 'none';
  if (UNINFORMATIVE_TIME_ZONE_PATTERNS.some((pattern) => pattern.test(timeZone))) return 'none';
  return 'non-cn';
}

function localeVote(locale: string | undefined): SignalVote {
  if (locale === undefined || locale.length === 0) return 'none';
  const lower = locale.toLowerCase();
  if (
    lower === 'zh' ||
    lower.startsWith('zh-hans') ||
    lower === 'zh-cn' ||
    lower.startsWith('zh-cn-')
  ) {
    return 'cn';
  }
  return 'non-cn';
}

export function detectKimiRegionFromLocalSignals(
  signals: LocalRegionSignals,
): LocalRegionDetection {
  const timeZone = timeZoneVote(signals.timeZone);
  const locale = localeVote(signals.locale);
  if (timeZone === 'non-cn' && locale !== 'cn') return { region: 'global', confident: true };
  if (timeZone === 'cn' && locale !== 'non-cn') {
    return { region: 'mainland-cn', confident: true };
  }
  if (timeZone === 'none' && locale === 'cn') {
    return { region: 'mainland-cn', confident: true };
  }
  return { region: 'mainland-cn', confident: false };
}
