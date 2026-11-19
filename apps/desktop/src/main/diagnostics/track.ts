
import type { TelemetryProperties } from '@moonshot-ai/agent-core-v2';

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
    try {
      impl(event, properties);
    } catch {}
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

export function trySendDesktopEvent<K extends DesktopEventName>(
  event: K,
  properties?: DesktopEventPayloads[K],
): void {
  try {
    trackDesktopEvent(event, properties);
  } catch {}
}

let locale: string | undefined;

export function setRuntimeLocale(next: string | undefined): void {
  locale = next;
}

export function getRuntimeLocale(): string | undefined {
  return locale;
}
