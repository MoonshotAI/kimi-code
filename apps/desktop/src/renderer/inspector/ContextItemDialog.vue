<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, Button, Dialog, EmptyState, Icon, IconButton, ScrollArea, SegmentedControl, Spinner } from '@moonshot-ai/app-ui';
import { getKimiWebApi } from '@moonshot-ai/app-client/client';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import type { SessionContextItemDetail, SessionContextItemSummary } from '@moonshot-ai/app-core/api';
import ContextPartView from './ContextPartView.vue';
import JsonTree from './JsonTree.vue';
import { contextItemText } from './contextCopy';

const props = defineProps<{
  sessionId: string;
  item: SessionContextItemSummary;
  index: number;
  total: number;
}>();
const emit = defineEmits<{ close: []; navigate: [direction: number] }>();
const { t } = useI18n();

const mode = ref<'parsed' | 'source'>('parsed');
const messageRoot = ref<HTMLElement>();
const detail = ref<SessionContextItemDetail | null>(null);
const loading = ref(false);
const error = ref('');
const copyState = ref<'idle' | 'copied' | 'failed'>('idle');
let fetchSeq = 0;
let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
let lastKeyNavigation = 0;

async function loadDetail(): Promise<void> {
  const sid = props.sessionId;
  const itemId = props.item.id;
  if (!sid || !itemId) return;
  const seq = ++fetchSeq;
  loading.value = true;
  error.value = '';
  try {
    const res = await getKimiWebApi().getSessionContextItem(sid, itemId);
    if (seq !== fetchSeq) return;
    detail.value = res;
  } catch (err) {
    if (seq !== fetchSeq) return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === fetchSeq) loading.value = false;
  }
}

function resetCopyState(): void {
  copyState.value = 'idle';
  clearTimeout(copyResetTimer);
}

watch([
  () => props.sessionId,
  () => props.item.id,
  () => props.item.role,
  () => props.item.chars,
  () => props.item.preview,
], () => {
  detail.value = null;
  resetCopyState();
  void loadDetail();
}, { immediate: true });

watch(mode, resetCopyState);
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  clearTimeout(copyResetTimer);
});

const title = computed(() => [
  props.item.sequence !== undefined ? `#${props.item.sequence}` : '',
  t(`inspector.role.${props.item.role}`, props.item.role),
  props.item.name ?? '',
].filter(Boolean).join(' · '));

const modeOptions = computed(() => [
  { value: 'parsed', label: t('inspector.parsedContent') },
  { value: 'source', label: t('inspector.sourceCode') },
]);

const sourceJson = computed(() => {
  if (!detail.value) return '';
  if (typeof detail.value.raw === 'string') return detail.value.raw;
  return JSON.stringify(detail.value.raw, null, 2) ?? '';
});
const readableText = computed(() => detail.value ? contextItemText(detail.value) : '');
const copyText = computed(() => mode.value === 'source' ? sourceJson.value : readableText.value);
const copyLabel = computed(() =>
  t(copyState.value === 'copied'
    ? 'inspector.copied'
    : copyState.value === 'failed'
      ? 'inspector.copyFailed'
      : mode.value === 'source' && typeof detail.value?.raw !== 'string'
        ? 'inspector.copyJson'
        : 'inspector.copyText'),
);

async function copyCurrentView(): Promise<void> {
  if (!detail.value) return;
  copyState.value = await copyTextToClipboard(copyText.value) ? 'copied' : 'failed';
  clearTimeout(copyResetTimer);
  copyResetTimer = setTimeout(() => (copyState.value = 'idle'), 1500);
}

function asObj(val: unknown): Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : {};
}

const toolDefinition = computed(() => {
  if (props.item.role !== 'definition' || !detail.value) return null;
  const raw = asObj(detail.value.raw);
  const fn = Object.keys(asObj(raw['function'])).length ? asObj(raw['function']) : raw;
  const schema = asObj(fn['parameters'] ?? fn['input_schema'] ?? fn['inputSchema']);
  const properties = asObj(schema['properties']);
  const required = new Set(Array.isArray(schema['required']) ? schema['required'].map(String) : []);
  const parameters = Object.entries(properties).map(([name, value]) => {
    const prop = asObj(value);
    const kind = Array.isArray(prop['type']) ? prop['type'].join(' | ') : typeof prop['type'] === 'string' ? prop['type'] : Array.isArray(prop['enum']) ? 'enum' : 'unknown';
    return {
      name,
      type: kind,
      required: required.has(name),
      description: typeof prop['description'] === 'string' ? prop['description'] : '',
      extra: Object.fromEntries(Object.entries(prop).filter(([k]) => !['type', 'description'].includes(k))),
    };
  });
  const extraSchema = Object.fromEntries(Object.entries(schema).filter(([k]) => !['type', 'properties', 'required'].includes(k)));
  return {
    description: typeof fn['description'] === 'string' ? fn['description'] : '',
    parameters,
    extraSchema,
  };
});

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const dialog = messageRoot.value?.closest<HTMLElement>('.ui-dialog');
  if (!dialog || dialog.inert) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    if (!dialog.contains(active) && active !== document.body) return;
    if (active.closest('input, textarea, [contenteditable="true"]')) return;
  }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const now = Date.now();
  if (now - lastKeyNavigation < 160) return;
  lastKeyNavigation = now;
  if (event.key === 'ArrowLeft' && props.index > 0) {
    emit('navigate', -1);
  } else if (event.key === 'ArrowRight' && props.index >= 0 && props.index < props.total - 1) {
    emit('navigate', 1);
  }
}
</script>

<template>
  <Dialog open :aria-label="title" size="lg" height="fixed" :padded="false" initial-focus=".context-message" @close="emit('close')">
    <section ref="messageRoot" class="context-message" :data-role="item.role" tabindex="-1">
      <header class="message-header">
        <span class="role-marker" />
        <h2 class="message-title">{{ title }}</h2>
        <span v-if="total > 0 && index >= 0" class="message-position">{{ index + 1 }} / {{ total }}</span>
        <IconButton v-if="total > 1" size="sm" :label="t('inspector.previousItem')" :tooltip="t('inspector.previousItem')" :disabled="index <= 0" @click="emit('navigate', -1)"><Icon name="chevron-left" size="sm" /></IconButton>
        <IconButton v-if="total > 1" size="sm" :label="t('inspector.nextItem')" :tooltip="t('inspector.nextItem')" :disabled="index < 0 || index >= total - 1" @click="emit('navigate', 1)"><Icon name="chevron-right" size="sm" /></IconButton>
        <IconButton size="sm" :label="t('inspector.closeDetail')" :tooltip="t('inspector.closeDetail')" @click="emit('close')"><Icon name="close" size="sm" /></IconButton>
      </header>
      <div class="message-toolbar">
        <SegmentedControl v-model="mode" :options="modeOptions" size="xs" :aria-label="title" />
        <div class="message-actions">
          <span class="message-chars">{{ t('inspector.characters', { n: item.chars.toLocaleString() }) }}</span>
          <Button size="xs" variant="text" :disabled="!detail" @click="copyCurrentView">
            <Icon :name="copyState === 'copied' ? 'check' : copyState === 'failed' ? 'close' : 'copy'" size="sm" />
            {{ copyLabel }}
          </Button>
        </div>
      </div>
      <div v-if="loading && !detail" class="message-loading"><Spinner size="sm" /></div>
      <div v-else-if="error && !detail" class="message-error" role="alert">
        <span>{{ error }}</span>
        <Button size="sm" variant="ghost" @click="loadDetail()">{{ t('inspector.retry') }}</Button>
      </div>
      <ScrollArea v-else-if="detail && mode === 'parsed'" class="message-body">
        <div v-if="toolDefinition" class="tool-view">
          <div v-if="toolDefinition.description" class="tool-section"><div class="prose">{{ toolDefinition.description }}</div></div>
          <div v-if="toolDefinition.parameters.length" class="tool-section">
            <div class="section-title">{{ t('inspector.toolParameters') }} · {{ toolDefinition.parameters.length }}</div>
            <div v-for="param in toolDefinition.parameters" :key="param.name" class="parameter-row">
              <div class="parameter-head"><code>{{ param.name }}</code><span class="parameter-type">{{ param.type }}</span><Badge :variant="param.required ? 'info' : 'neutral'">{{ t(param.required ? 'inspector.requiredParameter' : 'inspector.optionalParameter') }}</Badge></div>
              <div v-if="param.description" class="parameter-description">{{ param.description }}</div>
              <JsonTree v-if="Object.keys(param.extra).length" :value="param.extra" root />
            </div>
          </div>
          <div v-if="Object.keys(toolDefinition.extraSchema).length" class="tool-section">
            <div class="section-title">{{ t('inspector.schemaConstraints') }}</div>
            <div class="tree-pad"><JsonTree :value="toolDefinition.extraSchema" root /></div>
          </div>
        </div>
        <div v-else-if="detail.parts.length" class="part-list">
          <ContextPartView v-for="(part, idx) in detail.parts" :key="idx" :part="part" :role="detail.role" />
        </div>
        <EmptyState v-else :title="t('inspector.emptyMessage')" />
      </ScrollArea>
      <ScrollArea v-else-if="detail && mode === 'source'" class="message-body" orientation="both">
        <pre class="source-pre">{{ sourceJson }}</pre>
      </ScrollArea>
    </section>
  </Dialog>
</template>

<style scoped>
.context-message { display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0; font-family: var(--font-ui); font-size: var(--text-xs); color: var(--color-text); }
.context-message:focus { outline: none; }
.context-message[data-role="system"] { --context-color: var(--color-text-muted); }
.context-message[data-role="definition"] { --context-color: var(--color-context-definition); }
.context-message[data-role="user"] { --context-color: var(--color-info); }
.context-message[data-role="assistant"] { --context-color: var(--color-context-assistant); }
.context-message[data-role="tool"] { --context-color: var(--color-orange); }
.message-header { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); border-bottom: var(--p-hairline) solid var(--color-line); }
.role-marker { width: var(--space-2); height: var(--space-2); background: var(--context-color, var(--color-text-muted)); border-radius: var(--radius-context-segment); flex: none; }
.message-title { margin: 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: var(--weight-medium); }
.message-position { color: var(--color-text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.message-toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-1) var(--space-3); border-bottom: var(--p-hairline) solid var(--color-line); }
.message-actions { display: flex; align-items: center; gap: var(--space-1); }
.message-chars { color: var(--color-text-faint); font-variant-numeric: tabular-nums; }
.message-loading { display: flex; align-items: center; justify-content: center; flex: 1; }
.message-error { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-3); color: var(--color-danger); }
.message-body { flex: 1; min-height: 0; }
.part-list, .tool-view { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3); }
.tool-section { border: var(--p-hairline) solid var(--color-line); border-radius: var(--radius-sm); overflow: hidden; background: var(--color-bg); }
.section-title { padding: var(--space-1) var(--space-3); border-bottom: var(--p-hairline) solid var(--color-line); color: var(--color-text-muted); font-size: var(--text-xs); }
.prose { padding: var(--space-3); color: var(--color-text); font: var(--text-xs) var(--font-ui); line-height: var(--leading-relaxed); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.parameter-row { display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-2) var(--space-3); border-bottom: var(--p-hairline) solid var(--color-line); user-select: text; }
.parameter-row:last-child { border-bottom: 0; }
.parameter-head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.parameter-head code { color: var(--color-text); font-family: var(--font-mono); }
.parameter-type { color: var(--color-text-muted); font-family: var(--font-mono); font-size: var(--text-xs); }
.parameter-description { color: var(--color-text-muted); font-size: var(--text-xs); line-height: var(--leading-relaxed); white-space: pre-wrap; overflow-wrap: anywhere; }
.tree-pad { padding: var(--space-2); user-select: text; }
.source-pre { margin: 0; padding: var(--space-3); font: var(--text-xs) var(--font-mono); line-height: var(--leading-relaxed); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; color: var(--color-text); }
</style>
