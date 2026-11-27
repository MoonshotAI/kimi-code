export interface FormatDurationOptions {
  secondsDisplay?: 'auto' | 'always';
}

type DurationUnitKey = 'days' | 'hours' | 'minutes' | 'seconds';
type SelectedDurationUnit = [DurationUnitKey, number];

const FALLBACK_UNIT_SUFFIX: Record<DurationUnitKey, string> = {
  days: 'd',
  hours: 'h',
  minutes: 'm',
  seconds: 's',
};

const durationFormatters = new Map<string, Intl.DurationFormat>();

function isChineseLocale(locale: string): boolean {
  return locale.toLowerCase().startsWith('zh');
}

function getDurationFormatter(
  locale: string,
  style: 'narrow' | 'short',
  secondsDisplay: 'auto' | 'always',
): Intl.DurationFormat | null {
  if (typeof Intl.DurationFormat !== 'function') return null;
  const normalizedLocale = isChineseLocale(locale) ? 'zh-CN' : 'en-US';
  const key = `${normalizedLocale}:${style}:${secondsDisplay}`;
  let formatter = durationFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DurationFormat(normalizedLocale, { style, secondsDisplay });
    durationFormatters.set(key, formatter);
  }
  return formatter;
}

function selectDayScaleUnits(days: number, hours: number, minutes: number, seconds: number): SelectedDurationUnit[] {
  const candidates: SelectedDurationUnit[] = [
    ['days', days],
    ['hours', hours],
    ['minutes', minutes],
    ['seconds', seconds],
  ];
  return candidates.filter(([, value]) => value > 0).slice(0, 2);
}

function selectSubDayUnits(hours: number, minutes: number, seconds: number, secondsDisplay: 'auto' | 'always'): SelectedDurationUnit[] {
  if (hours > 0) {
    return minutes > 0 ? [['hours', hours], ['minutes', minutes]] : [['hours', hours]];
  }
  if (minutes > 0) {
    return seconds > 0 ? [['minutes', minutes], ['seconds', seconds]] : [['minutes', minutes]];
  }
  if (seconds > 0 || secondsDisplay === 'always') {
    return [['seconds', seconds]];
  }
  return [];
}

function selectDurationUnits(totalSeconds: number, secondsDisplay: 'auto' | 'always'): SelectedDurationUnit[] {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return days > 0
    ? selectDayScaleUnits(days, hours, minutes, seconds)
    : selectSubDayUnits(hours, minutes, seconds, secondsDisplay);
}

function isNumericPart(type: string): boolean {
  return type === 'integer' || type === 'fraction';
}

function formatSpacedDurationParts(formatter: Intl.DurationFormat, duration: Partial<Record<DurationUnitKey, number>>): string {
  let out = '';
  let prevType: string | undefined;
  for (const part of formatter.formatToParts(duration)) {
    if ((part.type === 'unit' && prevType !== undefined && isNumericPart(prevType)) || (isNumericPart(part.type) && prevType === 'unit')) {
      out += ' ';
    }
    out += part.value;
    prevType = part.type;
  }
  return out;
}

export function formatDuration(ms: number, locale: string = 'en', options: FormatDurationOptions = {}): string {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const secondsDisplay = options.secondsDisplay ?? 'auto';
  const selected = selectDurationUnits(totalSeconds, secondsDisplay);
  if (selected.length === 0) return '';

  const chinese = isChineseLocale(locale);
  const formatter = getDurationFormatter(locale, chinese ? 'short' : 'narrow', secondsDisplay);
  if (formatter === null) {
    return selected.map(([unit, value]) => `${value}${FALLBACK_UNIT_SUFFIX[unit]}`).join('');
  }

  const duration: Partial<Record<DurationUnitKey, number>> = {};
  for (const [unit, value] of selected) duration[unit] = value;
  return chinese ? formatSpacedDurationParts(formatter, duration) : formatter.format(duration);
}
