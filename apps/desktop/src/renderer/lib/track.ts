
import type { ProductTracker } from '@moonshot-ai/app-client/contracts';
import type { RendererEventName, RendererEventPayloads } from '../../shared/track-events';

interface TrackBridge {
  track?: (event: string, properties?: object) => void;
}

export function track<K extends RendererEventName>(
  event: K,
  properties: RendererEventPayloads[K],
): void {
  try {
    (window as { kimiDesktop?: TrackBridge }).kimiDesktop?.track?.(event, properties);
  } catch {}
}

export const productTracker: ProductTracker = {
  track: (event, payload) => track(event as RendererEventName, payload as never),
};
