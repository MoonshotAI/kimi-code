export function formatQuotaResumeTime(locale: string, iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const isZh = locale.toLowerCase().startsWith('zh');
  const timeOptions: Intl.DateTimeFormatOptions = isZh
    ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
    : { hour: 'numeric', minute: '2-digit' };
  const options: Intl.DateTimeFormatOptions = sameDay
    ? timeOptions
    : { month: 'short', day: 'numeric', ...timeOptions };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

export function formatMessageTime(iso: string, yesterdayLabel: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;

    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const timeStr = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

    const sameYear = d.getFullYear() === now.getFullYear();
    const sameMonth = d.getMonth() === now.getMonth();
    const sameDate = d.getDate() === now.getDate();

    if (sameYear && sameMonth && sameDate) {
      return timeStr;
    }

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate()
    ) {
      return `${yesterdayLabel} ${timeStr}`;
    }

    if (sameYear) {
      return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${timeStr}`;
    }

    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${timeStr}`;
  } catch {
    return iso;
  }
}
