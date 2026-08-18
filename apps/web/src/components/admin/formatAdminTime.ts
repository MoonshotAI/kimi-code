// apps/web/src/components/admin/formatAdminTime.ts
// Absolute timestamp for the session admin table's time columns:
// always `YYYY-MM-DD HH:mm` local (the admin page is an audit view —
// relative times like "2 hours ago" would make scanning dates harder).
// The compact variant (`MM-DD HH:mm`) is the responsive step down: the
// table swaps to it at medium widths before dropping the time columns
// entirely (see SessionAdminTable.vue's container queries).

/** Format Unix ms as `YYYY-MM-DD HH:mm` local time. */
export function formatAdminTime(ms: number): string {
  const d = new Date(ms);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Format Unix ms as `MM-DD HH:mm` local time (the compact responsive step). */
export function formatAdminTimeCompact(ms: number): string {
  const d = new Date(ms);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
