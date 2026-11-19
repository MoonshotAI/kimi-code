import { expect, it } from 'vitest';
import { browserViewportResizeRequest, resizedBrowserViewport } from '../../src/renderer/lib/browserViewportResize';
import { BROWSER_DEVICE_DIMENSION_MAX } from '../../src/shared/browser-device';
it('converts centered edge movement through the display scale and preserves the other dimension', () => {
  expect(resizedBrowserViewport({ width: 400, height: 800, scale: .5 }, { x: 25, y: 70 }, 'width', { width: 600, height: 600 })).toEqual({ width: 500, height: 800 });
  expect(resizedBrowserViewport({ width: 400, height: 800, scale: .5 }, { x: 25, y: -50 }, 'height', { width: 600, height: 600 })).toEqual({ width: 400, height: 600 });
});
it('bounds corner dragging by available canvas space and minimum page dimensions', () => {
  expect(resizedBrowserViewport({ width: 400, height: 800, scale: .5 }, { x: 9999, y: 9999 }, 'both', { width: 300, height: 500 })).toEqual({ width: 600, height: 1000 });
  expect(resizedBrowserViewport({ width: 400, height: 800, scale: .5 }, { x: -9999, y: -9999 }, 'both', { width: 300, height: 500 })).toEqual({ width: 50, height: 50 });
});
it('keeps the chosen scale mode and requested scale when resizing', () => {
  expect(browserViewportResizeRequest({ scaleMode: 'fit', requestedScale: 1 }, 400.4, 20)).toEqual({ enabled: true, profileId: 'responsive', width: 400, height: 50, orientation: 'landscape', scaleMode: 'fit' });
  expect(browserViewportResizeRequest({ scaleMode: 'fixed', requestedScale: 1 }, 600, 99999)).toEqual({ enabled: true, profileId: 'responsive', width: 600, height: BROWSER_DEVICE_DIMENSION_MAX, orientation: 'portrait', scaleMode: 'fixed', scale: 1 });
});
