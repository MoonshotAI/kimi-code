<!-- apps/web/src/components/chat/NotificationCard.vue -->
<!-- In-transcript card for a task notification (a hidden `<notification>`
     user message the agent received). ONE render block feeds `items`: a lone
     notification is a single status card, ≥2 consecutive ones collapse into a
     neutral group card whose compact rows expand individually. Spec: design
     system §04 (notification card). -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { TaskNotification } from '../../types';
import {
  notificationStatus,
  notificationVariant,
  type NotificationStatus,
  type NotificationVariant,
} from '@moonshot-ai/app-core/client';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import MessageTime from './MessageTime.vue';

const props = defineProps<{ items: TaskNotification[] }>();

const { t } = useI18n();

const isGroup = computed(() => props.items.length > 1);
const groupOpen = ref(false);
/** Expanded detail per notification key (single-card case holds ≤1 entry). */
const expanded = ref<Set<string>>(new Set());

function keyOf(n: TaskNotification, index: number): string {
  // The index must participate: a duplicated id (streamed + persisted copy of
  // the same notification, or a repeated id inside a merged payload) would
  // otherwise share one Vue key and one expanded-state slot.
  return n.id !== '' ? `${n.id}#${index}` : `ntf-${index}`;
}

function toggle(key: string): void {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

const STATUS_ICON: Record<NotificationStatus, string> = {
  completed: 'check',
  failed: 'alert-triangle',
  timed_out: 'clock',
  killed: 'stop',
  lost: 'alert-triangle',
  info: 'info',
};

function iconOf(n: TaskNotification): string {
  const status = notificationStatus(n);
  if (status === 'info' && n.sourceKind === 'subagent') return 'robot';
  return STATUS_ICON[status];
}

function kindLabel(n: TaskNotification): string {
  return n.sourceKind === 'subagent'
    ? t('conversation.notification.kindSubagent')
    : t('conversation.notification.kindTask');
}

function titleOf(n: TaskNotification): string {
  return t(`conversation.notification.title.${notificationStatus(n)}`, { kind: kindLabel(n) });
}

function statusWord(n: TaskNotification): string {
  return t(`conversation.notification.status.${notificationStatus(n)}`);
}

function variantOf(n: TaskNotification): NotificationVariant {
  return notificationVariant(n);
}

function dotClass(v: NotificationVariant): string {
  return v === 'ok' ? 'done' : v === 'err' ? 'error' : v === 'warn' ? 'warn' : '';
}

const groupSubtitle = computed(() =>
  props.items.map((n) => n.title).filter((s) => s !== '').join(' · '),
);

const copiedKey = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

async function copyPath(path: string, key: string): Promise<void> {
  const ok = await copyTextToClipboard(path);
  if (!ok) return;
  copiedKey.value = key;
  if (copiedTimer !== null) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedTimer = null;
    copiedKey.value = null;
  }, 1200);
}
</script>

<template>
  <!-- Group card: ≥2 consecutive notifications. -->
  <div v-if="isGroup" class="ntf-group-card" :class="{ open: groupOpen }">
    <button
      class="ntf-head"
      type="button"
      :aria-expanded="groupOpen"
      @click="groupOpen = !groupOpen"
    >
      <span class="ntf-chip"><Icon name="terminal" size="sm" /></span>
      <span class="ntf-main">
        <span class="ntf-title">{{ t('conversation.notification.groupTitle', { n: items.length }) }}</span>
        <span class="ntf-sub">{{ groupSubtitle }}</span>
      </span>
      <span class="ntf-side">
        <span class="ng-dots">
          <span v-for="(n, i) in items" :key="keyOf(n, i)" class="dot" :class="dotClass(variantOf(n))" />
        </span>
        <Icon class="ntf-car" name="chevron-right" size="sm" />
      </span>
    </button>
    <div v-show="groupOpen" class="ng-list">
      <div
        v-for="(n, i) in items"
        :key="keyOf(n, i)"
        class="ng-item"
        :class="[variantOf(n), { open: expanded.has(keyOf(n, i)) }]"
      >
        <button
          class="ntf-head"
          type="button"
          :aria-expanded="expanded.has(keyOf(n, i))"
          @click="toggle(keyOf(n, i))"
        >
          <span class="ntf-chip"><Icon :name="iconOf(n)" size="sm" /></span>
          <span class="ntf-main">
            <span class="ntf-title">{{ titleOf(n) }}</span>
            <span class="ntf-sub">{{ n.title }}</span>
          </span>
          <span class="ntf-side">
            <span class="st">{{ statusWord(n) }}</span>
            <MessageTime v-if="n.createdAt" :time="n.createdAt" />
            <Icon class="ntf-car" name="chevron-right" size="sm" />
          </span>
        </button>
        <div v-show="expanded.has(keyOf(n, i))" class="ntf-body">
          <div class="ntf-body-in">
            <div class="nd-fields">
              <span class="k">{{ t('conversation.notification.fields.type') }}</span><span class="v">{{ n.type }}</span>
              <span class="k">{{ t('conversation.notification.fields.source') }}</span><span class="v">{{ n.sourceKind }} · {{ n.sourceId }}</span>
              <span class="k">{{ t('conversation.notification.fields.severity') }}</span><span class="v">{{ n.severity || '—' }}</span>
            </div>
            <div v-if="n.body" class="nd-body">{{ n.body }}</div>
            <div v-if="n.outputFile" class="nd-out">
              <Icon class="nd-out-ic" name="file-text" size="sm" />
              <span class="path" :title="n.outputFile.path">{{ n.outputFile.path }}</span>
              <button class="nd-act" type="button" @click.stop="copyPath(n.outputFile.path, keyOf(n, i))">
                {{ copiedKey === keyOf(n, i) ? t('conversation.notification.copied') : t('conversation.notification.copyPath') }}
              </button>
            </div>
            <details class="nd-raw">
              <summary>
                <Icon class="nd-raw-car" name="chevron-right" size="sm" />
                <span>{{ t('conversation.notification.rawPayload') }}</span>
              </summary>
              <pre>{{ n.raw }}</pre>
            </details>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Single card. -->
  <div
    v-else-if="items[0]"
    class="ntf"
    :class="[variantOf(items[0]), { open: expanded.has(keyOf(items[0], 0)) }]"
  >
    <button
      class="ntf-head"
      type="button"
      :aria-expanded="expanded.has(keyOf(items[0], 0))"
      @click="toggle(keyOf(items[0], 0))"
    >
      <span class="ntf-chip"><Icon :name="iconOf(items[0])" size="sm" /></span>
      <span class="ntf-main">
        <span class="ntf-title">{{ titleOf(items[0]) }}</span>
        <span class="ntf-sub">{{ items[0].title }}</span>
      </span>
      <span class="ntf-side">
        <span class="st">{{ statusWord(items[0]) }}</span>
        <MessageTime v-if="items[0].createdAt" :time="items[0].createdAt" />
        <Icon class="ntf-car" name="chevron-right" size="sm" />
      </span>
    </button>
    <div v-show="expanded.has(keyOf(items[0], 0))" class="ntf-body">
      <div class="ntf-body-in">
        <div class="nd-fields">
          <span class="k">{{ t('conversation.notification.fields.type') }}</span><span class="v">{{ items[0].type }}</span>
          <span class="k">{{ t('conversation.notification.fields.source') }}</span><span class="v">{{ items[0].sourceKind }} · {{ items[0].sourceId }}</span>
          <span class="k">{{ t('conversation.notification.fields.severity') }}</span><span class="v">{{ items[0].severity || '—' }}</span>
        </div>
        <div v-if="items[0].body" class="nd-body">{{ items[0].body }}</div>
        <div v-if="items[0].outputFile" class="nd-out">
          <Icon class="nd-out-ic" name="file-text" size="sm" />
          <span class="path" :title="items[0].outputFile.path">{{ items[0].outputFile.path }}</span>
          <button class="nd-act" type="button" @click.stop="copyPath(items[0].outputFile.path, keyOf(items[0], 0))">
            {{ copiedKey === keyOf(items[0], 0) ? t('conversation.notification.copied') : t('conversation.notification.copyPath') }}
          </button>
        </div>
        <details class="nd-raw">
          <summary>
            <Icon class="nd-raw-car" name="chevron-right" size="sm" />
            <span>{{ t('conversation.notification.rawPayload') }}</span>
          </summary>
          <pre>{{ items[0].raw }}</pre>
        </details>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Card shell: status token pair (toast/attention vocabulary), neutral
   surface for info. */
.ntf,
.ntf-group-card {
  margin: var(--space-2) 0;
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
  animation: kimi-card-in var(--duration-slow) var(--ease-out);
}
.ntf.ok { background: var(--color-success-soft); border-color: var(--color-success-bd); }
.ntf.err { background: var(--color-danger-soft); border-color: var(--color-danger-bd); }
.ntf.warn { background: var(--color-warning-soft); border-color: var(--color-warning-bd); }

/* Head row: 28px status chip (sub-agent card's pa-ic language) + title/sub +
   status word · time + rotating chevron. */
.ntf-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  text-align: left;
  user-select: none;
}
.ntf-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-xs);
  flex: none;
  color: var(--color-text-muted);
}
.ntf.ok .ntf-chip { color: var(--color-success); }
.ntf.err .ntf-chip { color: var(--color-danger); }
.ntf.warn .ntf-chip { color: var(--color-warning); }

.ntf-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.ntf-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  line-height: var(--leading-normal);
}
.ntf-sub {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ntf-side {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.ntf-side .st { font-weight: var(--weight-medium); }
.ntf.ok .st, .ng-item.ok .st { color: var(--color-success); }
.ntf.err .st, .ng-item.err .st { color: var(--color-danger); }
.ntf.warn .st, .ng-item.warn .st { color: var(--color-warning); }
.ntf-car {
  color: var(--color-text-faint);
  transition: transform var(--duration-base) var(--ease-out);
}
.ntf.open > .ntf-head .ntf-car,
.ntf-group-card.open > .ntf-head .ntf-car,
.ng-item.open > .ntf-head .ntf-car {
  transform: rotate(90deg);
}

/* Body: fields / prose / output-file row / raw payload, separated by a 0.5px
   hairline in the card's status border colour. */
.ntf-body-in {
  margin: 0 var(--space-3) var(--space-3);
  padding-top: var(--space-3);
  border-top: 0.5px solid var(--color-line);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.ntf.ok .ntf-body-in, .ng-item.ok .ntf-body-in { border-top-color: var(--color-success-bd); }
.ntf.err .ntf-body-in, .ng-item.err .ntf-body-in { border-top-color: var(--color-danger-bd); }
.ntf.warn .ntf-body-in, .ng-item.warn .ntf-body-in { border-top-color: var(--color-warning-bd); }

.nd-fields {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-1) var(--space-3);
}
.nd-fields .k { color: var(--color-text-faint); font-size: var(--text-xs); }
.nd-fields .v {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nd-body {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.nd-out {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  background: var(--color-surface-raised);
  border-radius: var(--radius-md);
  padding: var(--space-1) var(--space-2);
  box-shadow: var(--shadow-xs);
}
.nd-out-ic { color: var(--color-text-faint); flex: none; }
.nd-out .path {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}
.nd-act {
  display: inline-flex;
  align-items: center;
  height: var(--space-6);
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  border: 0.5px solid var(--color-line-strong);
  background: var(--color-surface-raised);
  flex: none;
  transition: color var(--duration-fast) var(--ease-out);
}
.nd-act:hover { color: var(--color-text); }

.nd-raw summary {
  list-style: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  cursor: pointer;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  user-select: none;
}
.nd-raw summary::-webkit-details-marker { display: none; }
.nd-raw summary:hover { color: var(--color-text); }
.nd-raw-car { transition: transform var(--duration-base) var(--ease-out); }
.nd-raw[open] .nd-raw-car { transform: rotate(90deg); }
.nd-raw pre {
  margin: var(--space-2) 0 0;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-raised);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-xs);
  font-size: var(--text-xs);
  line-height: 1.55;
  color: var(--color-text-muted);
  overflow-x: auto;
  white-space: pre;
}

/* Group head dots. */
.ng-dots { display: inline-flex; gap: var(--space-1); margin-right: var(--space-1); }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--color-text-faint); }
.dot.done { background: var(--color-success); }
.dot.error { background: var(--color-danger); }
.dot.warn { background: var(--color-warning); }

/* Group items: compact rows on the shared rhythm, 0.5px subtle separators. */
.ng-list {
  display: flex;
  flex-direction: column;
}
.ng-item { border-top: 0.5px solid var(--color-subtle); }
.ng-item > .ntf-head { padding: var(--space-1) var(--space-3); }
.ng-item .ntf-chip {
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  box-shadow: none;
  background: transparent;
}
.ng-item.ok .ntf-chip { color: var(--color-success); }
.ng-item.err .ntf-chip { color: var(--color-danger); }
.ng-item.warn .ntf-chip { color: var(--color-warning); }
.ng-item .ntf-title { font-weight: var(--weight-regular); color: var(--color-text-muted); }
.ng-item.open .ntf-title { color: var(--color-text); }
</style>
