<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFontMetadata } from '@moonshot-ai/app-client/composables';
import { loadBundledFont, quoteFontFamily } from '@moonshot-ai/app-core/composables';
import { fontMetadataText, getBundledFont } from '@moonshot-ai/app-core/lib';

const props = defineProps<{ family: string; label?: string }>();
const { locale } = useI18n();
const { fontMetadata, previewFontMetadata, releaseFontMetadata } = useFontMetadata();
const host = ref<HTMLElement>();
const metadata = computed(() => fontMetadata.value[props.family]?.metadata);
const bundled = computed(() => getBundledFont(props.family));
const name = computed(() => props.label || bundled.value?.label || fontMetadataText(metadata.value, locale.value, 'name') || props.family);
const sample = computed(() => fontMetadataText(metadata.value, locale.value, 'sample') || 'The Dark Side of the Moon 江月何年初照人 3.1415926');
const sampleStyle = computed(() => ({
  fontFamily: `${quoteFontFamily(props.family.replace(/["\\]/g, ''))}, "Adobe Blank 2"`,
}));
let observer: IntersectionObserver | undefined;

onMounted(() => {
  void loadBundledFont(props.family);
  if (!host.value) return;
  if (typeof IntersectionObserver === 'undefined') {
    void previewFontMetadata(props.family);
    return;
  }
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void previewFontMetadata(props.family);
    else releaseFontMetadata(props.family);
  });
  observer.observe(host.value);
});

onUnmounted(() => {
  observer?.disconnect();
  releaseFontMetadata(props.family);
});
</script>

<template>
  <span ref="host" class="font-option-content">
    <span class="font-option-name">
      {{ name }}
      <span v-if="name !== family && !bundled && !label" class="font-option-original">{{ family }}</span>
    </span>
    <span class="font-option-sample" :style="sampleStyle" :title="sample" aria-hidden="true">{{ sample }}</span>
  </span>
</template>

<style scoped>
@font-face {
  font-family: "Adobe Blank 2";
  font-display: block;
  src: url("./assets/AdobeBlank2.otf.woff") format("woff");
}
.font-option-content {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4);
  min-width: 0;
  width: 100%;
  height: 1lh;
  overflow: clip;
  overflow-clip-margin: var(--space-1);
}
.font-option-name {
  flex: none;
  white-space: nowrap;
  font-family: var(--font-ui);
  font-size: var(--text-base);
}
.font-option-original {
  margin-inline-start: var(--space-2);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
}
.font-option-sample {
  flex: 1 1 0;
  min-width: 80px;
  overflow-x: clip;
  overflow-y: visible;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  font-size: var(--text-base);
  color: var(--color-text-muted);
  font-weight: var(--weight-regular);
}
</style>
