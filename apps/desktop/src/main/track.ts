// Host telemetry facade. Events fired before embedded telemetry is wired (app
// launch, startup phases) are buffered and replayed once wiring completes;
// without an impl the buffer is the only place they exist, so it stays small.

import type { TelemetryProperties } from '@moonshot-ai/agent-core-v2';

import {
  rendererTrackEventSchema,
  type RendererTrackEvent,
} from '../shared/track-events';
import type { DesktopEventName, DesktopEventPayloads } from './telemetry-events';

type TrackImpl = (event: string, properties?: TelemetryProperties) => void;

const MAX_PENDING_EVENTS = 200;

let impl: TrackImpl | null = null;
let pending: Array<{ event: string; properties?: TelemetryProperties }> = [];

export function setDesktopTrackImpl(next: TrackImpl | null): void {
  impl = next;
  if (impl === null) {
    pending = [];
    return;
  }
  const replay = pending;
  pending = [];
  for (const { event, properties } of replay) {
    impl(event, properties);
  }
}

export function trackDesktopEvent<K extends DesktopEventName>(
  event: K,
  properties?: DesktopEventPayloads[K],
): void {
  const props = properties as TelemetryProperties | undefined;
  if (impl === null) {
    if (pending.length >= MAX_PENDING_EVENTS) pending.shift();
    pending.push({ event, properties: props });
    return;
  }
  impl(event, props);
}

// --- kimi:track IPC payloads --------------------------------------------------

export function asRendererTrackEvent(
  event: unknown,
  payload: unknown,
): RendererTrackEvent | null {
  const result = rendererTrackEventSchema.safeParse({ event, properties: payload });
  return result.success ? result.data : null;
}
