import type { Component } from '@moonshot-ai/pi-tui';

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
