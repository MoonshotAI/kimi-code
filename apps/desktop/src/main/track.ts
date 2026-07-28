// Host telemetry facade; it is a no-op unless embedded telemetry is wired.

import type { TelemetryProperties } from '@moonshot-ai/agent-core-v2';

import {
  rendererTrackEventSchema,
  type RendererTrackEvent,
} from '../shared/track-events';
import type { DesktopEventName, DesktopEventPayloads } from './telemetry-events';

type TrackImpl = (event: string, properties?: TelemetryProperties) => void;

let impl: TrackImpl | null = null;

export function setDesktopTrackImpl(next: TrackImpl | null): void {
  impl = next;
}

export function trackDesktopEvent<K extends DesktopEventName>(
  event: K,
  properties?: DesktopEventPayloads[K],
): void {
  impl?.(event, properties as TelemetryProperties | undefined);
}

// --- kimi:track IPC payloads --------------------------------------------------

export function asRendererTrackEvent(
  event: unknown,
  payload: unknown,
): RendererTrackEvent | null {
  const result = rendererTrackEventSchema.safeParse({ event, properties: payload });
  return result.success ? result.data : null;
}
