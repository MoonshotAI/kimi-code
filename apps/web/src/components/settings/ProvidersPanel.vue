<!-- apps/web/src/components/settings/ProvidersPanel.vue -->
<!-- Providers settings tab (accordion, design F): each provider is a full-width
     row (id + type badge + model count + chevron) that expands inline into the
     shared ProviderForm — view = edit = add. At most one item is open; the add
     form pins to the top of the list, driven by the sec-head button. Collapsing
     or switching with unsaved edits inserts an inline guard bar (keep editing /
     discard) — never a modal. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppProvider } from '../../api/types';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { isManagedOAuthProvider, providerModelRows } from '@moonshot-ai/app-core/lib';
import AddProviderFlow from './AddProviderFlow.vue';
import ProviderForm from './ProviderForm.vue';
import { Badge, Button, Icon, Spinner } from '@moonshot-ai/app-ui';

const { t } = useI18n();
const client = useKimiWebClient();

/** openKey value for the pinned add-form row. Deliberately fails the provider
    id pattern (`$`), so a real provider can never collide with the sentinel. */
const ADD_KEY = '$add';

const loading = ref(true);
/** Accordion state: provider id | ADD_KEY | null — at most one item is open. */
const openKey = ref<string | null>(null);
/** The item that is mid-collapse: its form stays mounted for the 0fr→1fr
    transition so closing animates too. */
const leavingKey = ref<string | null>(null);
let leaveTimer = 0;

/** Dirty flag of the currently open form (synced from the child). */
const dirty = ref(false);
const guardVisible = ref(false);
/** Where tryOpen wants to go while the guard is up (null = collapse). */
const pendingOpen = ref<string | null>(null);

const flashId = ref('');
let flashTimer = 0;

// Sorted by id (dictionary order).
const providers = computed<AppProvider[]>(() =>
  [...client.providers.value].sort((a, b) => a.id.localeCompare(b.id)),
);

function modelCountFor(p: AppProvider): number {
  return providerModelRows(p, client.config.value?.models).length;
}

watch(openKey, (next, prev) => {
  if (prev !== null && prev !== next) {
    leavingKey.value = prev;
    window.clearTimeout(leaveTimer);
    // Timer instead of transitionend: reduced-motion kills the transition,
    // so the event may never fire. 300ms = --duration-slow (260ms) + slack.
    leaveTimer = window.setTimeout(() => {
      leavingKey.value = null;
    }, 300);
  }
  // The newly opened form starts clean.
  dirty.value = false;
});

// Every path that clears dirty (save/add success, cancel, discard) must also
// retire the guard — otherwise the bar outlives the state it protects and its
// "discard" button would jump to a stale pendingOpen.
watch(dirty, (next) => {
  if (!next) {
    guardVisible.value = false;
    pendingOpen.value = null;
  }
});

onUnmounted(() => {
  window.clearTimeout(leaveTimer);
  window.clearTimeout(flashTimer);
});

/** The add row mounts collapsed and gets its `open` class one frame later —
    applying it at mount would skip the 0fr→1fr transition and read as a jump. */
const addOpen = ref(false);
watch(openKey, (next) => {
  if (next === ADD_KEY) {
    addOpen.value = false;
    void nextTick(() => requestAnimationFrame(() => { addOpen.value = true; }));
  } else {
    addOpen.value = false;
  }
});

onMounted(async () => {
  loading.value = true;
  try {
    // All three loaders catch and toast their own failures. config must be
    // fresh too: model counts and the edit form's rows derive from its
    // models section, which another client may have rewritten since launch.
    await Promise.all([client.loadProviders(), client.loadModels(), client.loadConfig()]);
  } finally {
    loading.value = false;
  }
});

function tryOpen(key: string): void {
  const target = openKey.value === key ? null : key;
  if (dirty.value) {
    pendingOpen.value = target;
    guardVisible.value = true;
    return;
  }
  openKey.value = target;
}

function onGuardStay(): void {
  guardVisible.value = false;
  pendingOpen.value = null;
}

function onGuardDiscard(): void {
  guardVisible.value = false;
  openKey.value = pendingOpen.value;
  pendingOpen.value = null;
}

function flashRow(id: string): void {
  flashId.value = id;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    flashId.value = '';
  }, 1200);
}

function onSaved(id: string): void {
  // Renames move the row — re-point the open item. No flash: the success toast
  // already confirms; the flash is reserved for the add flow's row insertion.
  openKey.value = id;
}

function onAdded(id: string): void {
  // The add row turns into the new provider's expanded edit row in place.
  openKey.value = id;
  flashRow(id);
}

function onDeleted(): void {
  openKey.value = null;
}
</script>

<template>
  <section class="pp">
    <div class="pp-head">
      <h3 class="pp-title">{{ t('settings.tabs.providers') }}</h3>
      <Button variant="secondary" size="sm" @click="tryOpen(ADD_KEY)">
        <Icon name="plus" size="sm" />
        {{ t('providers.addProvider') }}
      </Button>
    </div>

    <div v-if="loading" class="pp-loading">
      <Spinner size="sm" />
      <span>{{ t('providers.loading') }}</span>
    </div>

    <div v-else class="pp-group">
      <!-- Add form, pinned to the top of the list while open -->
      <div
        v-if="openKey === ADD_KEY || leavingKey === ADD_KEY"
        class="pp-item pp-add-item"
        :class="{ open: openKey === ADD_KEY && addOpen }"
      >
        <button type="button" class="pp-row pp-add-row" @click="tryOpen(ADD_KEY)">
          <span class="pp-add-label">{{ t('providers.addProvider') }}</span>
          <span class="grow" />
          <span class="pp-chev"><Icon name="chevron-right" size="sm" /></span>
        </button>
        <div class="pp-acc">
          <div class="pp-acc-in">
            <AddProviderFlow
              :guard="guardVisible && openKey === ADD_KEY"
              @dirty-change="dirty = $event"
              @guard-stay="onGuardStay"
              @guard-discard="onGuardDiscard"
              @added="onAdded"
              @cancel="openKey = null"
            />
          </div>
        </div>
      </div>

      <div v-if="providers.length === 0" class="pp-empty">{{ t('providers.empty') }}</div>

      <div
        v-for="p in providers"
        :key="p.id"
        class="pp-item"
        :class="{ open: openKey === p.id, flash: flashId === p.id }"
      >
        <button type="button" class="pp-row" @click="tryOpen(p.id)">
          <div class="grow">
            <span class="pp-id">{{ p.id }}</span>
            <Badge variant="neutral" size="sm">{{ p.type }}</Badge>
            <Badge v-if="isManagedOAuthProvider(p)" variant="info" size="sm">
              {{ t('providers.managedBadge') }}
            </Badge>
          </div>
          <span class="pp-count">{{ t('providers.modelCount', { count: modelCountFor(p) }) }}</span>
          <span class="pp-chev"><Icon name="chevron-right" size="sm" /></span>
        </button>
        <div class="pp-acc">
          <div class="pp-acc-in">
            <ProviderForm
              v-if="openKey === p.id || leavingKey === p.id"
              mode="edit"
              :provider="p"
              :guard="guardVisible && openKey === p.id"
              @dirty-change="dirty = $event"
              @guard-stay="onGuardStay"
              @guard-discard="onGuardDiscard"
              @saved="onSaved"
              @deleting="openKey = null"
              @deleted="onDeleted"
            />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pp { display: flex; flex-direction: column; }
.pp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.pp-title {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}

.pp-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4) 0;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
}

/* Group language mirrors SettingsDialog's .settings-group. */
.pp-group {
  overflow: hidden;
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-xl);
  background: var(--color-surface-raised);
}
.pp-group > * + * { border-top: 0.5px solid var(--color-line); }

.pp-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 40px;
  padding: var(--space-2) var(--space-4);
  border: none;
  background: transparent;
  text-align: left;
  font-family: var(--font-ui);
  color: var(--color-text);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.pp-row:hover { background: var(--color-hover); }
.pp-item.open > .pp-row { background: var(--color-surface-sunken); }
.pp-row .grow {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.pp-id {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pp-count {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  white-space: nowrap;
}
.pp-chev {
  display: inline-flex;
  flex: none;
  color: var(--color-text-faint);
  transition: transform var(--duration-base) var(--ease-out);
}
.pp-item.open .pp-chev { transform: rotate(90deg); }

.pp-add-row {
  gap: var(--space-2);
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}

/* Accordion: 0fr→1fr animates open/close and auto-sizes as model rows are
   added or removed. */
.pp-acc { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--duration-slow) var(--ease-out); }
.pp-item.open > .pp-acc { grid-template-rows: 1fr; }
.pp-acc-in { overflow: hidden; min-height: 0; }
/* Once open, the content must escape the mask or the type dropdown clips. */
.pp-item.open .pp-acc-in { overflow: visible; }

.pp-item.flash > .pp-row { animation: pp-flash 1.2s var(--ease-out); }
@keyframes pp-flash {
  0% { background: var(--color-accent-soft); }
  100% { background: transparent; }
}

.pp-empty {
  padding: var(--space-5) var(--space-4);
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  text-align: center;
}
</style>
