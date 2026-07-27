export function focusLeavesWindowsMenu(
  nextTarget: EventTarget | null,
  triggers: Iterable<EventTarget | undefined>,
): boolean {
  return nextTarget === null || !Array.from(triggers).includes(nextTarget);
}

type AltKeyEvent = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

export class StandaloneAltTracker {
  private pending = false;

  keydown(event: AltKeyEvent): void {
    if (event.key === 'Alt') {
      this.pending = !event.ctrlKey && !event.metaKey && !event.shiftKey;
    } else if (event.altKey) {
      this.pending = false;
    }
  }

  keyup(event: AltKeyEvent): boolean {
    const standalone =
      event.key === 'Alt' &&
      this.pending &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey;
    if (event.key === 'Alt') this.pending = false;
    return standalone;
  }
}
