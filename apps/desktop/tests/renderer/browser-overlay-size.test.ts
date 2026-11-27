import { afterEach, expect, it, vi } from 'vitest';
import { measureBrowserOverlayCard } from '../../src/renderer/lib/browserOverlaySize';

afterEach(() => vi.unstubAllGlobals());

it('measures the final border box instead of the scaled entrance frame', () => {
  vi.stubGlobal('getComputedStyle', () => ({ width: '520px', height: '200px', transform: 'matrix(0.97, 0, 0, 0.97, 0, 2)' }));
  const card = { offsetWidth: 520, offsetHeight: 200, getBoundingClientRect: () => ({ width: 504.4, height: 194 }) } as HTMLElement;
  expect(measureBrowserOverlayCard(card)).toEqual({ width: 520, height: 200 });
});

it('rounds fractional layout dimensions outwards so the native surface cannot cut the border', () => {
  vi.stubGlobal('getComputedStyle', () => ({ width: '243.4px', height: '211.7px' }));
  expect(measureBrowserOverlayCard({ offsetWidth: 243, offsetHeight: 212 } as HTMLElement)).toEqual({ width: 244, height: 212 });
});
