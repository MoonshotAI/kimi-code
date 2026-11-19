export function listMarkerWidth(start: number, values: (number | null)[], reversed = false): string {
  let current = start;
  let characters = 1;
  for (const value of values) {
    if (value !== null) current = value;
    characters = Math.max(characters, String(current).length);
    current += reversed ? -1 : 1;
  }
  return `${characters + 2}ch`;
}
