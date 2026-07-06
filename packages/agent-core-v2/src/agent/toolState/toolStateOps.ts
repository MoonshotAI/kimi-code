/**
 * `toolState` domain (L3) — wire Model (`ToolStoreModel`) and the
 * `tools.update_store` Op (`updateStore`) for the agent's opaque tool store.
 *
 * Declares the store as an open `Record<string, unknown>` wire Model (the
 * per-key shape is augmented by domains via `ToolStoreData` declaration
 * merging) plus the single Op that writes one key; `defineOp` registers the Op
 * into the global registry at import, so `wire.dispatch(updateStore({ key,
 * value }))` mutates the model and `wire.replay` rebuilds it from persisted
 * records. Consumed by the Agent-scope `toolStateService`.
 */

import { defineModel, defineOp } from '#/wire';

export const ToolStoreModel = defineModel<Record<string, unknown>>('toolState', () => ({}));

export const updateStore = defineOp(ToolStoreModel, 'tools.update_store', {
  apply: (s, p: { key: string; value: unknown }) => ({ ...s, [p.key]: p.value }),
});
