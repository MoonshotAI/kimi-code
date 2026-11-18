import type { Component } from '@moonshot-ai/pi-tui';

import type { TranscriptEntry } from '../types';

const componentEntries = new WeakMap<Component, TranscriptEntry>();
const componentTurnIds = new WeakMap<Component, string>();

export function markTranscriptComponent(component: Component, entry: TranscriptEntry): void {
  componentEntries.set(component, entry);
}

export function getTranscriptComponentEntry(
  component: Component,
): TranscriptEntry | undefined {
  return componentEntries.get(component);
}

export function markTranscriptComponentTurnId(
  component: Component,
  turnId: string | undefined,
): void {
  if (turnId !== undefined) componentTurnIds.set(component, turnId);
}

export function getTranscriptComponentTurnId(component: Component): string | undefined {
  return componentEntries.get(component)?.turnId ?? componentTurnIds.get(component);
}
