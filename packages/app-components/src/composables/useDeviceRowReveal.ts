import { nextTick, onUnmounted, ref, type Ref } from 'vue';

const FLASH_MS = 1200;

export function useDeviceRowReveal(root: Ref<HTMLElement | undefined>) {
  const flashId = ref('');
  let flashTimer = 0;

  onUnmounted(() => window.clearTimeout(flashTimer));

  function flash(deviceId: string): void {
    flashId.value = deviceId;
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      flashId.value = '';
    }, FLASH_MS);
  }

  function reveal(deviceId: string): void {
    flash(deviceId);
    void nextTick(() => {
      const row = [...(root.value?.querySelectorAll<HTMLElement>('[data-device-id]') ?? [])]
        .find((item) => item.dataset.deviceId === deviceId);
      row?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  return { flashId, flash, reveal };
}
