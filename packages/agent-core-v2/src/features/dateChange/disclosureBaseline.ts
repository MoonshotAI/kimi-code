export function pickDisclosureBaseline<T extends { readonly renderGeneration: number }>(
  ...candidates: readonly (T | undefined)[]
): T | undefined {
  let winner: T | undefined;
  for (const candidate of candidates) {
    if (
      candidate !== undefined &&
      (winner === undefined || candidate.renderGeneration > winner.renderGeneration)
    ) {
      winner = candidate;
    }
  }
  return winner;
}
