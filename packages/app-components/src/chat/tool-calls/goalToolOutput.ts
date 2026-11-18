export function updateGoalVisibleOutput(lines: readonly string[]): string[] {
  const blank = lines.findIndex((line) => line.trim() === '');
  return blank > 0 ? lines.slice(0, blank) : [...lines];
}
