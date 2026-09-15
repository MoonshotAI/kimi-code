import { z } from 'zod';

import type { AgentEventStore } from '#/agent/slices';
import { defineEvent, eventSchemaFor } from '#/eventStore/events';
import { createSlice, type Slice } from '#/eventStore/slice';
import type { DurableBackend, DurableSlice } from '#/kernel/index';

const storePatchedSchema = z.object({
  store: z.string(),
  patch: z.record(z.string(), z.unknown()),
});

function ensureStorePatchedRegistered(): void {
  if (eventSchemaFor('store.patched') === undefined) {
    defineEvent({ type: 'store.patched', schema: storePatchedSchema });
  }
}

export function createDurableBackend(store: AgentEventStore): DurableBackend {
  ensureStorePatchedRegistered();
  return {
    registerSlice: (slice: DurableSlice) =>
      store.registerSlice(createSlice(slice as unknown as Slice<string, unknown>)),
    dispatch: (event) => store.dispatch({ ...event, time: Date.now() }),
    subscribe: (listener) => store.subscribe((state) => listener(state)),
    getState: () => store.getState(),
  };
}
