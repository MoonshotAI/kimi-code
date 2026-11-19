
export function formatDuration(ms: number, units?: { h: string; m: string; s: string }): string {
  const u = units ?? { h: 'h', m: 'm', s: 's' };
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s === 0 ? '' : `${s}${u.s}`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rest = s % 60;
    return rest === 0 ? `${m}${u.m}` : `${m}${u.m}${rest}${u.s}`;
  }
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h}${u.h}` : `${h}${u.h}${rest}${u.m}`;
}
