export interface DisplaySourceLike {
  display_id: string;
}

export function findSingleDisplaySourceFallback<T extends DisplaySourceLike>(
  sources: readonly T[],
  displayCount: number,
): T | undefined {
  if (displayCount !== 1 || sources.length !== 1 || sources[0]!.display_id !== '') return undefined;
  return sources[0];
}
