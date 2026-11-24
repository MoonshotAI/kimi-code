<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import { useKimiI18n } from '@moonshot-ai/app-i18n';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import IconButton from './IconButton.vue';
import Icon from './Icon.vue';
import Spinner from './Spinner.vue';
import { useToastTimer } from './useToastTimer';
import type { ToastOptions } from './toastTypes';

const props = withDefaults(defineProps<ToastOptions>(), {
  layout: 'card',
  variant: 'info',
  title: '',
});

const emit = defineEmits<{ close: [] }>();

const { t } = useKimiI18n();

const detailsOpen = ref(false);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

const timer = useToastTimer({
  duration: () => props.duration ?? (props.layout === 'bar' ? 8000 : props.variant === 'danger' ? 12000 : 6000),
  onExpire: () => emit('close'),
});

function dismiss(): void {
  emit('close');
}

function resume(): void {
  if (detailsOpen.value) return;
  timer.resume();
}

function toggleDetails(): void {
  detailsOpen.value = !detailsOpen.value;
  if (detailsOpen.value) timer.pause();
  else resume();
}

async function copyText(text: string): Promise<void> {
  const ok = await copyTextToClipboard(text);
  if (!ok) return;
  copied.value = true;
  if (copiedTimer !== null) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = false;
    copiedTimer = null;
  }, 1400);
}

function copyDetails(): void {
  const lines = [props.title];
  if (props.message) lines.push(props.message);
  const details = props.details ?? [];
  if (details.length > 0) {
    lines.push('', `${t('warnings.diagnostics')}:`);
    for (const detail of details) lines.push(`${detail.label}: ${detail.value}`);
  }
  void copyText(lines.join('\n'));
}

onUnmounted(() => {
  if (copiedTimer !== null) clearTimeout(copiedTimer);
});
</script>

<template>
  <div
    v-if="layout === 'bar'"
    class="ui-toast-bar"
    :class="`ui-toast--${variant}`"
    role="status"
    @pointerenter="timer.pause"
    @pointerleave="resume"
  >
    <span v-if="variant === 'success' || running" class="ui-toast__icon" aria-hidden="true">
      <Spinner v-if="running" size="sm" />
      <Icon v-else name="check" />
    </span>
    <span class="ui-toast-bar__body">
      <slot>
        {{ title }}<button
          v-for="action in actions ?? []"
          :key="action.label"
          class="ui-toast__link"
          type="button"
          @click="action.onClick({ dismiss })"
        >{{ action.label }}</button>
      </slot>
    </span>
    <IconButton
      class="ui-toast__close"
      size="sm"
      :label="dismissLabel ?? t('common.dismiss')"
      :tooltip="dismissLabel ?? t('common.dismiss')"
      @click="dismiss"
    >
      <Icon name="close" size="sm" />
    </IconButton>
  </div>
  <div
    v-else
    class="ui-toast"
    :class="`ui-toast--${variant}`"
    role="status"
    @pointerenter="timer.pause"
    @pointerleave="resume"
  >
    <span class="ui-toast__icon" aria-hidden="true">
      <slot name="icon">
        <Icon v-if="variant === 'success'" name="check" />
        <Icon v-else-if="variant === 'danger'" name="close" />
        <Icon v-else-if="variant === 'warning'" name="alert-triangle" />
        <Icon v-else name="info" />
      </slot>
    </span>
    <div class="ui-toast__body">
      <div class="ui-toast__title">{{ title }}</div>
      <div v-if="message" class="ui-toast__msg">{{ message }}</div>
      <slot />
      <div v-if="copyLink || details?.length || actions?.length" class="ui-toast__actions">
        <button v-if="copyLink" class="ui-toast__link" type="button" @click="void copyText(copyLink.url)">
          {{ copied ? copyLink.copiedLabel : copyLink.label }}
        </button>
        <button v-if="details?.length" class="ui-toast__link" type="button" @click="toggleDetails">
          {{ detailsOpen ? t('warnings.hideDetails') : t('warnings.showDetails') }}
        </button>
        <button v-if="details?.length" class="ui-toast__link" type="button" @click="copyDetails">
          {{ copied ? t('warnings.copied') : t('warnings.copyDetails') }}
        </button>
        <button
          v-for="action in actions ?? []"
          :key="action.label"
          class="ui-toast__link"
          type="button"
          @click="action.onClick({ dismiss })"
        >{{ action.label }}</button>
      </div>
      <dl v-if="detailsOpen && details?.length" class="ui-toast__details">
        <div v-for="detail in details" :key="`${detail.label}:${detail.value}`" class="ui-toast__detail-row">
          <dt>{{ detail.label }}</dt>
          <dd>{{ detail.value }}</dd>
        </div>
      </dl>
    </div>
    <IconButton
      class="ui-toast__close"
      size="sm"
      :label="dismissLabel ?? t('common.dismiss')"
      :tooltip="dismissLabel ?? t('common.dismiss')"
      @click="dismiss"
    >
      <Icon name="close" size="sm" />
    </IconButton>
  </div>
</template>

<style scoped>
.ui-toast {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  width: 360px;
  max-width: 100%;
  padding: 13px 14px;
  background: var(--color-surface-raised);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  font-family: var(--font-ui);
  line-height: 1.45;
}
.ui-toast__icon {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-full);
  display: grid;
  place-items: center;
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.ui-toast__icon svg { width: 12px; height: 12px; }
.ui-toast--success .ui-toast__icon { background: var(--color-success-soft); color: var(--color-success); }
.ui-toast--warning .ui-toast__icon { background: var(--color-warning-soft); color: var(--color-warning); }
.ui-toast--danger .ui-toast__icon { background: var(--color-danger-soft); color: var(--color-danger); }
.ui-toast--danger { border-color: color-mix(in srgb, var(--color-danger) 35%, transparent); }
.ui-toast__body { flex: 1; min-width: 0; }
.ui-toast__title {
  font-size: var(--text-base);
  font-weight: 500;
  line-height: 20px;
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.ui-toast__msg {
  margin-top: 2px;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.ui-toast--danger .ui-toast__msg { color: var(--color-danger); }
.ui-toast__close { flex: none; margin: -3px -4px 0 0; }
.ui-toast__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.ui-toast__link {
  border: 0;
  padding: 0;
  background: none;
  color: var(--color-accent);
  cursor: pointer;
  font: inherit;
  font-size: var(--text-xs);
}
.ui-toast__link:hover {
  color: var(--color-accent-hover);
  text-decoration: underline;
}
.ui-toast__link:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
  border-radius: var(--radius-xs);
}
.ui-toast__details {
  display: grid;
  gap: 5px;
  margin: 8px 0 0;
  padding: 8px;
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
}
.ui-toast__detail-row {
  display: grid;
  grid-template-columns: minmax(88px, 0.34fr) minmax(0, 1fr);
  gap: 8px;
}
.ui-toast__detail-row dt { color: var(--color-text-muted); }
.ui-toast__detail-row dd {
  margin: 0;
  color: var(--color-text);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.ui-toast-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 6px 4px 14px;
  background: var(--color-surface-raised);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: 1.45;
  color: var(--color-text);
  max-width: calc(100vw - 32px);
}
.ui-toast-bar__body { min-width: 0; }
.ui-toast-bar .ui-toast__link {
  font-size: var(--text-base);
  margin-inline: var(--space-1);
}
.ui-toast-bar__body :deep(button) {
  border: 0;
  padding: 0;
  margin-inline: var(--space-1);
  background: none;
  color: var(--color-accent);
  cursor: pointer;
  font: inherit;
}
.ui-toast-bar__body :deep(button:hover) {
  color: var(--color-accent-hover);
  text-decoration: underline;
}
.ui-toast-bar__body :deep(button:focus-visible) {
  outline: none;
  box-shadow: var(--p-focus-ring);
  border-radius: var(--radius-xs);
}
.ui-toast-bar .ui-toast__close { margin: 0; }

@media (max-width: 640px) {
  .ui-toast__detail-row {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
</style>
