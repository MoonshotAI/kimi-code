// packages/app-core/src/lib/formatDuration.ts

/** Whole-second duration, `37s` / `1m37s` / `6m` / `1h4m` — the only
    user-visible duration vocabulary: floored to whole seconds (never a
    decimal fraction), trailing zero units dropped (`6m`, not `6m0s`).
    Sub-second spans return '' — callers hide them ("0s" reads like clutter).
    Unit suffixes default to h/m/s; pass `units` to localize. */
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
