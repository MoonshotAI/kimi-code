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
