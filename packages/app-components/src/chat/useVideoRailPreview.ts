import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import { getKimiWebApi } from '@moonshot-ai/app-client/client';
import { createVideoThumbnail } from '@moonshot-ai/app-client/lib';

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
export function useVideoRailPreview(
  host: Ref<HTMLElement | null>,
  props: { fileId: string; sessionId?: string },
): Ref<string | undefined> {
  const visible = ref(false);
  const thumbnail = ref<string>();
  let observer: IntersectionObserver | undefined;

  watch(() => [props.fileId, props.sessionId, visible.value] as const, async (_, __, onCleanup) => {
    thumbnail.value = undefined;
    if (!visible.value) return;
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    try {
      const options = { prefixBytes: MAX_PREVIEW_BYTES, signal: controller.signal };
      const api = getKimiWebApi();
      const blob = props.sessionId
        ? await api.getSessionMediaBlob(props.sessionId, props.fileId, options)
        : await api.getFileBlob(props.fileId, options);
      if (controller.signal.aborted) return;
      const result = await createVideoThumbnail(blob, controller.signal);
      if (!controller.signal.aborted) thumbnail.value = result;
    } catch {
      if (!controller.signal.aborted) thumbnail.value = undefined;
    }
  });

  onMounted(() => {
    if (typeof IntersectionObserver !== 'function' || host.value === null) {
      visible.value = true;
      return;
    }
    observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      visible.value = true;
      observer?.disconnect();
      observer = undefined;
    }, { rootMargin: '200px' });
    observer.observe(host.value);
  });

  onBeforeUnmount(() => observer?.disconnect());
  return thumbnail;
}
