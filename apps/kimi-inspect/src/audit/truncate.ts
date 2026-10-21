export const TRUNCATE_KEEP = 500;

export function tailTrunc(value: string, keep: number = TRUNCATE_KEEP): string {
  if (value.length <= keep) return value;
  return `… [${value.length} chars total, showing last ${keep}]\n${value.slice(-keep)}`;
}
