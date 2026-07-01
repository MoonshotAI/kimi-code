import { ref } from 'vue';

/**
 * Number of design-system `Dialog` instances currently open. App.vue's
 * capture-phase Escape handler reads this so any open dialog — including ones
 * whose open state lives outside App.vue (e.g. the sidebar session search) —
 * owns Escape over the background side panel. Incremented/decremented by
 * `Dialog.vue` as `open` flips.
 */
export const openDialogCount = ref(0);
