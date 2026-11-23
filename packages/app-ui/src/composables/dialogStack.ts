import { computed, ref } from 'vue';

export const openDialogCount = ref(0);

export const openSheetCount = ref(0);

const dialogStack = ref<symbol[]>([]);

export const topDialogId = computed(() => dialogStack.value[dialogStack.value.length - 1]);

export function pushDialog(id: symbol): void {
  dialogStack.value = [...dialogStack.value, id];
  openDialogCount.value += 1;
}

export function removeDialog(id: symbol): void {
  const index = dialogStack.value.lastIndexOf(id);
  if (index < 0) return;
  const next = [...dialogStack.value];
  next.splice(index, 1);
  dialogStack.value = next;
  openDialogCount.value = Math.max(0, openDialogCount.value - 1);
}
