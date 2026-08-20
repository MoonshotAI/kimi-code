import { ref } from 'vue';

/**
 * Number of design-system `Dialog` instances currently open. App.vue's
 * capture-phase Escape handler reads this so any open dialog — including ones
 * whose open state lives outside App.vue (e.g. the sidebar session search) —
 * owns Escape over the background side panel. Incremented/decremented by
 * `Dialog.vue` as `open` flips.
 */
export const openDialogCount = ref(0);

/**
 * Number of app-level `BottomSheet` instances currently open — the sheet
 * counterpart of `openDialogCount`. Mobile warning toasts read this (with the
 * dialog count) to drop below the scrim — and pause their countdown — while a
 * sheet owns the screen. Incremented/decremented by `BottomSheet.vue` as
 * `modelValue` flips.
 */
export const openSheetCount = ref(0);
