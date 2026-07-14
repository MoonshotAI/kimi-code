/**
 * `config` domain (L2) — module-level config-overlay contribution collector.
 *
 * Mirrors `configSectionContributions.ts` but for `ConfigEffectiveOverlay`s.
 * An owner domain calls `registerConfigOverlay(...)` at the top level of the
 * module that defines the overlay; `ConfigRegistry` drains the collected
 * overlays when it is constructed. Pure data — no DI, no container — so
 * `config` never imports any owner domain, and an overlay becomes active as
 * soon as its owning module is imported, regardless of whether the consuming
 * Service is instantiated.
 *
 * This decouples overlay registration from Service lifetime: an overlay must
 * not depend on an `Eager` Service being constructed, since the DI layer does
 * not auto-instantiate `Eager` services (see `ModelService` /
 * `kimiModelEnvOverlay`).
 */

import type { ConfigEffectiveOverlay } from './config';

const _overlays: ConfigEffectiveOverlay[] = [];

export function registerConfigOverlay(overlay: ConfigEffectiveOverlay): void {
  _overlays.push(overlay);
}

export function getConfigOverlayContributions(): readonly ConfigEffectiveOverlay[] {
  return _overlays;
}

export function _clearConfigOverlayContributionsForTests(): void {
  _overlays.length = 0;
}
