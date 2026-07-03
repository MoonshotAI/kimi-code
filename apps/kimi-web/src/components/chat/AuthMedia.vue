<!-- apps/kimi-web/src/components/chat/AuthMedia.vue
     Renders a user-uploaded image/video whose bytes live in the daemon file
     store. The bare getFileUrl(fileId) 401s when used as a <video>/<img> src
     because the browser loads those natively and never attaches our Bearer
     credential — so when a fileId is present we fetch the bytes through the
     authenticated API client and play from a page-local blob URL instead. -->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { getKimiWebApi } from '../../api';

const props = withDefaults(
  defineProps<{
    url: string;
    kind: 'image' | 'video';
    alt?: string;
    /** File-store id. When present the bytes are fetched with auth and played
     *  from a blob URL; otherwise `url` is used directly (e.g. a data: URL). */
    fileId?: string;
    mediaClass?: string;
    /** Video: show native controls. Defaults to true (chat bubble); queue
     *  thumbnails pass false. */
    controls?: boolean;
    /** Video: start muted. */
    muted?: boolean;
  }>(),
  { mediaClass: 'u-img', controls: true, muted: false },
);

const resolvedUrl = ref<string>(props.fileId ? '' : props.url);
let objectUrl: string | null = null;

function revoke(): void {
  if (objectUrl !== null) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

async function resolve(): Promise<void> {
  revoke();
  if (!props.fileId) {
    resolvedUrl.value = props.url;
    return;
  }
  try {
    const blob = await getKimiWebApi().getFileBlob(props.fileId);
    objectUrl = URL.createObjectURL(blob);
    resolvedUrl.value = objectUrl;
  } catch {
    // Honest broken-media state beats a blank box if the authenticated fetch fails.
    resolvedUrl.value = props.url;
  }
}

watch(() => [props.fileId, props.url] as const, resolve, { immediate: true });
onBeforeUnmount(revoke);
</script>

<template>
  <video
    v-if="kind === 'video'"
    :class="mediaClass"
    :src="resolvedUrl || undefined"
    :controls="controls"
    :muted="muted"
    playsinline
    preload="metadata"
  />
  <img
    v-else
    :class="mediaClass"
    :src="resolvedUrl || undefined"
    :alt="alt || ''"
    loading="lazy"
  />
</template>
