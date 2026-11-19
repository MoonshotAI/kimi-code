
export function formatAdminTime(ms: number): string {
  const d = new Date(ms);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatAdminTimeCompact(ms: number): string {
  const d = new Date(ms);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
