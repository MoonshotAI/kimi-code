const ZONE_SUFFIX = /(?:Z|([+-])(\d{2}):?(\d{2}))$/i;

const STYLE: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' };

export function formatZonedDateTime(locale: string, value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const zone = ZONE_SUFFIX.exec(value.trim());
  if (!zone) return new Intl.DateTimeFormat(locale, STYLE).format(date);
  const offsetMinutes =
    zone[1] === undefined ? 0 : (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3]));
  return new Intl.DateTimeFormat(locale, { ...STYLE, timeZone: 'UTC' }).format(
    new Date(date.getTime() + offsetMinutes * 60000),
  );
}
