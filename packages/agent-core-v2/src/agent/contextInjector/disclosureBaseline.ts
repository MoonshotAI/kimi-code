/**
 * `contextInjector` domain (L4) — disclosure-baseline helpers for reminder
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

import type { ContextInjectionDisclosure } from '#/agent/contextMemory/types';

export function disclosureOfKind<K extends ContextInjectionDisclosure['kind']>(
  disclosure: ContextInjectionDisclosure | undefined,
  kind: K,
): Extract<ContextInjectionDisclosure, { kind: K }> | undefined {
  return disclosure?.kind === kind
    ? (disclosure as Extract<ContextInjectionDisclosure, { kind: K }>)
    : undefined;
}

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
