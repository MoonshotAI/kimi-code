import type { Component } from '@moonshot-ai/pi-tui';

import { UserMessageComponent } from '../components/messages/user-message';
import type { TranscriptEntry } from '../types';

const componentEntries = new WeakMap<Component, TranscriptEntry>();

export function markTranscriptComponent(component: Component, entry: TranscriptEntry): void {
  componentEntries.set(component, entry);
}

export function getTranscriptComponentEntry(
  component: Component,
): TranscriptEntry | undefined {
  return componentEntries.get(component);
}

export function isTurnBoundaryComponent(child: Component): boolean {
  if (!(child instanceof UserMessageComponent)) return false;
  const entry = getTranscriptComponentEntry(child);
  if (entry === undefined) return false;
  // Live user messages have an undefined turnId; replayed user messages get a
  // `replay:N` turnId. Both start a new turn. Steer messages carry a defined
  // non-replay turnId and are not boundaries.
  return entry.turnId === undefined || entry.turnId.startsWith('replay:');
}
