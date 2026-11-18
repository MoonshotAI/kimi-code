import { BROWSER_DEVICE_DIMENSION_MIN, BROWSER_DEVICE_DIMENSION_MAX, type BrowserDeviceModeRequest, type BrowserDeviceState } from '../../shared/browser-device';

export function resizedBrowserViewport(start: { width: number; height: number; scale: number }, delta: { x: number; y: number }, axis: string, available: { width: number; height: number }): { width: number; height: number } {
  const dimension = (value: number, limit: number) => Math.max(BROWSER_DEVICE_DIMENSION_MIN, Math.min(BROWSER_DEVICE_DIMENSION_MAX, Math.round(Math.min(value, limit / start.scale))));
  return {
    width: axis === 'height' ? start.width : dimension(start.width + delta.x * 2 / start.scale, available.width),
    height: axis === 'width' ? start.height : dimension(start.height + delta.y * 2 / start.scale, available.height),
  };
}

export function browserViewportResizeRequest(device: Pick<BrowserDeviceState, 'scaleMode' | 'requestedScale'>, width: number, height: number): BrowserDeviceModeRequest {
  const clamp = (value: number) => Math.max(BROWSER_DEVICE_DIMENSION_MIN, Math.min(BROWSER_DEVICE_DIMENSION_MAX, Math.round(value)));
  const size = { enabled: true, profileId: 'responsive', width: clamp(width), height: clamp(height), orientation: width <= height ? 'portrait' : 'landscape' } as const;
  return device.scaleMode === 'fixed' ? { ...size, scaleMode: 'fixed', scale: device.requestedScale } : { ...size, scaleMode: 'fit' };
}
