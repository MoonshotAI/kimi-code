/**
 * `contextInjector` domain (L4) — disclosure-baseline helper for reminder
 * providers (currently `date_change`).
 *
 * A provider's baseline answers "what has the model already seen" from up to
 * three sources, compared by render generation with ties won by the earlier
 * argument: the typed disclosure on the provider's newest surviving
 * in-context injection (newest in time on a tie, since the persisted floor
 * never advances when a reminder fires), the persisted render-time floor, and
 * a runtime seed recorded on first observation. Internal to the package; not
 * part of the barrel export.
 */

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
