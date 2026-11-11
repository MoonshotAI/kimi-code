import type { LoopEmitted } from '@moonshot-ai/core/loop/index';

interface NotificationState {
  readonly onConsume?: () => void;
  readonly onDrop?: () => void;
  materialized: boolean;
  dropped: boolean;
}

export class AgentNotificationProjection {
  private readonly states = new Map<string, NotificationState>();

  register(promptId: string, callbacks: { readonly onConsume?: () => void; readonly onDrop?: () => void }): NotificationState {
    const state: NotificationState = {
      onConsume: callbacks.onConsume,
      onDrop: callbacks.onDrop,
      materialized: false,
      dropped: false,
    };
    this.states.set(promptId, state);
    return state;
  }

  isMaterialized(promptId: string): boolean {
    return this.states.get(promptId)?.materialized === true;
  }

  isDropped(promptId: string): boolean {
    return this.states.get(promptId)?.dropped === true;
  }

  drop(promptId: string): void {
    const state = this.states.get(promptId);
    if (state === undefined || state.materialized || state.dropped) return;
    state.dropped = true;
    state.onDrop?.();
  }

  project(event: LoopEmitted): void {
    switch (event.type) {
      case 'message.appended': {
        if (event.source !== 'notify' && event.source !== 'remind') return;
        const promptId = (event.entry.meta as { readonly promptId?: string } | undefined)?.promptId;
        if (promptId === undefined) return;
        const state = this.states.get(promptId);
        if (state === undefined || state.materialized || state.dropped) return;
        state.materialized = true;
        state.onConsume?.();
        return;
      }
      case 'prompt.canceled':
        if (event.canceled) this.drop(event.promptId);
        return;
      default:
        return;
    }
  }

  close(): void {
    for (const state of this.states.values()) {
      if (!state.materialized && !state.dropped) {
        state.dropped = true;
        state.onDrop?.();
      }
    }
  }
}
