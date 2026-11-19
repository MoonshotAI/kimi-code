<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Icon, IconButton, MetricBadge } from '@moonshot-ai/app-ui';
import type { BrowserAnnotationDetails } from '../../../shared/browser-annotation-details';
import AnnotationSection from './AnnotationSection.vue';
import AnnotationScroll from './AnnotationScroll.vue';
const props = defineProps<{ details: BrowserAnnotationDetails; readOnly?: boolean }>();
const emit = defineEmits<{ insert: [value: string] }>();
const labels = computed(() => props.details.labels);
const capture = computed(() => props.details.capture);
const element = computed(() => capture.value.target.kind === 'element' ? capture.value.target : undefined);
const attributes = computed(() => element.value?.attributes ?? {});
const classes = computed(() => (attributes.value['class'] ?? '').split(/\s+/).filter(Boolean));
const expandedClasses = ref(false);
const feedback = ref('');
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => { clock = setInterval(() => { now.value = Date.now(); }, 30_000); });
onUnmounted(() => clearInterval(clock));
const relativeTime = computed(() => {
  const seconds = Math.max(0, Math.round((now.value - Date.parse(capture.value.capturedAt)) / 1000));
  if (!Number.isFinite(seconds)) return '';
  const [value, unit] = seconds < 60 ? [seconds, 'second'] as const : seconds < 3600 ? [Math.floor(seconds / 60), 'minute'] as const : seconds < 86400 ? [Math.floor(seconds / 3600), 'hour'] as const : [Math.floor(seconds / 86400), 'day'] as const;
  return new Intl.RelativeTimeFormat(props.details.locale, { numeric: 'auto' }).format(-value, unit);
});
const absoluteTime = computed(() => new Date(capture.value.capturedAt).toLocaleString(props.details.locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
const data = computed(() => Object.entries(attributes.value).filter(([key]) => key.startsWith('data-')));
const semantics = computed(() => [
  ['role', element.value?.role, true], ['name', element.value?.accessibleName, false], ['text', element.value?.text, false],
  ...Object.entries(attributes.value).filter(([key]) => !['id', 'class'].includes(key) && !key.startsWith('data-')).map(([key, value]) => [key, ['disabled', 'readonly'].includes(key) ? 'true' : value, !['alt', 'placeholder'].includes(key)]),
].filter((row) => typeof row[1] === 'string' && row[1] !== '') as [string, string, boolean][]);
const classGroups = computed(() => {
  const grouped = new Map<string, string[]>();
  for (const name of classes.value) {
    const prefix = name.slice(0, name.lastIndexOf(':'));
    const label = /(^|:)(sm|md|lg|xl|2xl)(:|$)/.test(prefix) ? labels.value.responsive : /(^|:)(dark|light)(:|$)/.test(prefix) ? labels.value.theme : /(^|:)(hover|focus|focus-visible|active|disabled|group-hover|peer-checked)(:|$)/.test(prefix) ? labels.value.interaction : labels.value.base;
    grouped.set(label, [...(grouped.get(label) ?? []), name]);
  }
  return [...grouped].map(([label, values]) => ({ label, values }));
});
async function copy(value: string): Promise<void> {
  try { await navigator.clipboard.writeText(value); feedback.value = labels.value.copied; }
  catch { feedback.value = labels.value.copyFailed; }
}
const rounded = (value: number): string => String(Math.round(value * 100) / 100);
</script>
<template>
  <div class="annotation-details">
    <div v-if="attributes.id" class="property"><span class="key">ID</span><span class="value code">{{ attributes.id }}</span></div>
    <div v-if="classes.length" class="property class-property">
      <span class="key">{{ labels.classes }}</span>
      <div class="value">
        <AnnotationScroll v-if="expandedClasses" class="classes-scroll">
          <div v-for="group in classGroups" :key="group.label">
            <div v-if="classGroups.length > 1" class="class-category">{{ group.label }}</div>
            <div class="class-list"><span v-for="name in group.values" :key="name" class="class-pill"><span class="code class-name">{{ name }}</span><span class="class-actions"><button type="button" :aria-label="`${labels.copy} ${name}`" :title="labels.copy" @click="copy(name)"><Icon name="copy" /></button><button type="button" :disabled="readOnly" :aria-label="`${labels.insert} ${name}`" :title="labels.insert" @click="emit('insert', name)"><Icon name="plus" /></button></span></span></div>
          </div>
        </AnnotationScroll>
        <div v-else class="class-list"><span v-for="name in classes.slice(0, 6)" :key="name" class="class-pill"><span class="code class-name">{{ name }}</span><span class="class-actions"><button type="button" :aria-label="`${labels.copy} ${name}`" :title="labels.copy" @click="copy(name)"><Icon name="copy" /></button><button type="button" :disabled="readOnly" :aria-label="`${labels.insert} ${name}`" :title="labels.insert" @click="emit('insert', name)"><Icon name="plus" /></button></span></span></div>
        <button v-if="classes.length > 6" type="button" class="class-more" @click="expandedClasses = !expandedClasses">{{ expandedClasses ? labels.less : `${labels.more} ${classes.length - 6} ${labels.items}` }}</button>
      </div>
    </div>
    <AnnotationSection :title="labels.geometry">
      <div v-for="[key, value] in [['Selector', element?.locator?.selector], ['XPath', element?.locator?.xpath]]" :key="key" v-show="value" class="property"><span class="key">{{ key }}</span><div class="value copy-value"><span class="code">{{ value }}</span><IconButton size="sm" :label="`${labels.copy} ${key}`" :tooltip="labels.copy" @click="copy(value!)"><Icon name="copy" size="sm" /></IconButton></div></div>
      <div class="property"><span class="key">{{ labels.size }}</span><div class="metrics"><MetricBadge v-for="[key, value] in [[labels.width, capture.target.bounds.width], [labels.height, capture.target.bounds.height]]" :key="key" :label="String(key)">{{ rounded(Number(value)) }} px</MetricBadge></div></div>
      <div class="property"><span class="key">{{ labels.position }}</span><div class="metrics"><MetricBadge v-for="[key, value] in [['X', capture.target.bounds.x], ['Y', capture.target.bounds.y]]" :key="key" :label="String(key)">{{ rounded(Number(value)) }}</MetricBadge></div></div>
    </AnnotationSection>
    <AnnotationSection v-if="semantics.length" :title="labels.semantics"><div v-for="[key, value, code] in semantics" :key="key" class="property"><span class="key">{{ key }}</span><span class="value clamp" :class="{ code }">{{ value }}</span></div></AnnotationSection>
    <AnnotationSection v-if="data.length" :title="labels.data" :detail="`${data.length} ${data.length === 1 ? labels.item : labels.items}`"><AnnotationScroll class="data-scroll"><div v-for="[key, value] in data" :key="key" class="property data-property"><span class="key">{{ key }}</span><div class="value copy-value"><span class="code clamp">{{ value }}</span><IconButton size="sm" :label="`${labels.copy} ${key}`" :tooltip="labels.copy" @click="copy(value)"><Icon name="copy" size="sm" /></IconButton></div></div></AnnotationScroll></AnnotationSection>
    <p v-if="element?.attributesTruncated" class="notice">{{ labels.truncated }}</p>
    <AnnotationSection :title="labels.source" :detail="relativeTime">
      <div class="property"><span class="key">{{ labels.pageTitle }}</span><span class="value">{{ capture.page.title }}</span></div>
      <div class="property"><span class="key">{{ labels.url }}</span><span class="value code">{{ capture.page.url }}</span></div>
      <div class="property"><span class="key">{{ labels.capturedAt }}</span><span class="value numeric">{{ absoluteTime }}</span></div>
      <div class="property"><span class="key">{{ labels.viewport }}</span><div class="metrics"><MetricBadge v-for="[key, value] in [[labels.width, `${capture.viewport.width} px`], [labels.height, `${capture.viewport.height} px`], [labels.zoom, `${rounded(capture.viewport.zoomFactor * 100)}%`], [labels.pixelRatio, capture.viewport.devicePixelRatio]]" :key="key" :label="String(key)">{{ value }}</MetricBadge></div></div>
    </AnnotationSection>
    <span class="feedback" role="status">{{ feedback }}</span>
  </div>
</template>
<style scoped>
.annotation-details { min-width: 0; }
.property { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr); gap: var(--space-3); align-items: baseline; padding-block: var(--space-1); }
.key { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-section-label); overflow-wrap: anywhere; }
.value { min-width: 0; font-size: var(--text-xs); line-height: var(--leading-normal); overflow-wrap: anywhere; }
.code { font-family: var(--font-mono); word-break: break-all; }
.numeric { font-variant-numeric: tabular-nums; }
.copy-value { display: flex; gap: var(--space-1); align-items: flex-start; }
.copy-value > span { flex: 1; min-width: 0; }
.copy-value > button { flex: none; }
.clamp { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.class-property { padding-bottom: var(--space-3); }
.class-list { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.class-pill { display: inline-flex; max-width: 100%; align-items: center; gap: .125rem; padding: 0 .125rem 0 .375rem; background: var(--color-surface-sunken); border: var(--p-hairline) solid var(--color-line); border-radius: var(--radius-xs); }
.class-name { min-width: 0; }
.class-actions { display: inline-flex; flex: none; }
.class-actions button { display: grid; place-items: center; width: .875rem; height: .875rem; padding: 0; border: 0; border-radius: var(--radius-xs); background: transparent; color: var(--color-text-muted); cursor: pointer; }
.class-actions :deep(svg) { width: .625rem; height: .625rem; }
.class-actions button:hover { background: var(--color-hover); color: var(--color-text); }
.class-actions button:disabled { opacity: .5; cursor: not-allowed; }
.class-actions button:focus-visible, .class-more:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.class-more { border: 0; padding: var(--space-1) 0; background: none; color: var(--color-text-muted); font: inherit; font-size: var(--text-xs); cursor: pointer; }
.class-category { font-family: var(--font-ui); font-weight: var(--weight-section-label); color: var(--color-text-muted); margin-block: var(--space-1); }
.classes-scroll { max-height: 10rem; }
.data-scroll { max-height: 12rem; }
.data-property { grid-template-columns: 7rem minmax(0, 1fr); align-items: start; }
.metrics { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.notice { font-size: var(--text-xs); color: var(--color-text-muted); }
.feedback { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
