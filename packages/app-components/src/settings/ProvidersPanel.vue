<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppProvider } from '@moonshot-ai/app-core/api';
import { MANAGED_KIMI_CODE_PROVIDER_ID } from '@moonshot-ai/app-core/api';
import { providerDisplayName, providerModelRows } from '@moonshot-ai/app-core/lib';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { Badge, Button, Icon, Spinner } from '@moonshot-ai/app-ui';
import AddProviderPage from './AddProviderPage.vue';
import ManagedProviderView from './ManagedProviderView.vue';
import ProviderBrandIcon from './ProviderBrandIcon.vue';
import ProviderForm from './ProviderForm.vue';

const emit = defineEmits<{
  login: [];
}>();

type PanelView =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'edit'; provider: AppProvider }
  | { kind: 'managed' };

const { t } = useI18n();
const client = useKimiWebClient();

const loading = ref(true);
const view = ref<PanelView>({ kind: 'list' });

const flashId = ref('');
let flashTimer = 0;

const customProviders = computed<AppProvider[]>(() =>
  [...client.providers.value]
    .filter((p) => p.id !== MANAGED_KIMI_CODE_PROVIDER_ID)
    .sort((a, b) => a.id.localeCompare(b.id)),
);

const managedProvider = computed<AppProvider | undefined>(() =>
  client.providers.value.find((p) => p.id === MANAGED_KIMI_CODE_PROVIDER_ID),
);

const signedIn = computed(() => client.managedProviderStatus.value === 'authenticated');

const managedModelCount = computed(() => {
  const p = managedProvider.value;
  return p === undefined ? 0 : providerModelRows(p, client.config.value?.models).length;
});

const editingProvider = computed(() => (view.value.kind === 'edit' ? view.value.provider : undefined));

function modelCountFor(p: AppProvider): number {
  return providerModelRows(p, client.config.value?.models).length;
}

onMounted(async () => {
  loading.value = true;
  try {
    await Promise.all([client.loadProviders(), client.loadModels(), client.loadConfig()]);
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => {
  window.clearTimeout(flashTimer);
});

function navigate(next: PanelView): void {
  view.value = next;
}

function backToList(): void {
  navigate({ kind: 'list' });
}

function flashRow(id: string): void {
  flashId.value = id;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    flashId.value = '';
  }, 1200);
}

function onAdded(id: string): void {
  view.value = { kind: 'list' };
  flashRow(id);
}

function onDeleted(): void {
  view.value = { kind: 'list' };
}

function onManagedRow(): void {
  if (signedIn.value) navigate({ kind: 'managed' });
  else emit('login');
}
</script>

<template>
  <section class="pp">
    <template v-if="view.kind === 'list'">
      <div class="pp-head">
        <h3 class="sec-title">{{ t('settings.tabs.providers') }}</h3>
        <Button variant="secondary" size="sm" @click="navigate({ kind: 'add' })">
          <Icon name="plus" size="sm" />
          {{ t('providers.addProvider') }}
        </Button>
      </div>

      <div v-if="loading" class="settings-loading">
        <Spinner size="sm" />
        <span>{{ t('providers.loading') }}</span>
      </div>

      <template v-else>
        <h4 class="pp-group-title">{{ t('providers.groupManaged') }}</h4>
        <div class="settings-group settings-group-divided">
          <button type="button" class="pp-row" @click="onManagedRow">
            <ProviderBrandIcon :id="MANAGED_KIMI_CODE_PROVIDER_ID" size="sm" />
            <div class="grow">
              <span class="pp-id">{{ t('providers.kimiSubscription') }}</span>
              <Badge variant="neutral" size="sm">{{ t('providers.managedBuiltin') }}</Badge>
              <Badge v-if="signedIn" variant="info" size="sm">{{ t('providers.managedBadge') }}</Badge>
            </div>
            <template v-if="signedIn">
              <span class="pp-count">{{ t('providers.modelCount', { count: managedModelCount }) }}</span>
              <span class="pp-chev"><Icon name="chevron-right" size="sm" /></span>
            </template>
            <span v-else class="pp-login-tag">{{ t('providers.loginAction') }}</span>
          </button>
        </div>

        <h4 class="pp-group-title">{{ t('providers.groupCustom') }}</h4>
        <div class="settings-group settings-group-divided">
          <div v-if="customProviders.length === 0" class="pp-empty">
            <div class="pp-empty-title">{{ t('providers.emptyCustom') }}</div>
            <div class="pp-empty-hint">{{ t('providers.emptyCustomHint') }}</div>
          </div>
          <button
            v-for="p in customProviders"
            :key="p.id"
            type="button"
            class="pp-row"
            :class="{ flash: flashId === p.id }"
            @click="navigate({ kind: 'edit', provider: p })"
          >
            <ProviderBrandIcon :id="p.id" size="sm" />
            <div class="grow">
              <span class="pp-id">{{ providerDisplayName(p.id, t) }}</span>
              <Badge variant="neutral" size="sm">{{ p.type }}</Badge>
            </div>
            <span v-if="p.hasApiKey" class="pp-count">
              {{ t('providers.modelCount', { count: modelCountFor(p) }) }}
            </span>
            <span v-else class="pp-pending">{{ t('providers.pendingConfig') }}</span>
            <span class="pp-chev"><Icon name="chevron-right" size="sm" /></span>
          </button>
        </div>
      </template>
    </template>

    <AddProviderPage
      v-else-if="view.kind === 'add'"
      @added="onAdded"
      @cancel="backToList"
    />

    <ProviderForm
      v-else-if="view.kind === 'edit' && editingProvider !== undefined"
      mode="edit"
      :provider="editingProvider"
      @saved="onAdded"
      @deleted="onDeleted"
      @cancel="backToList"
    />

    <ManagedProviderView
      v-else-if="view.kind === 'managed'"
      :provider="managedProvider"
      @cancel="backToList"
      @login="emit('login')"
    />
  </section>
</template>

<style scoped src="./settings-common.css"></style>

<style scoped>
.pp { display: flex; flex-direction: column; }
.pp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.pp-head .sec-title { margin: 0; }

.pp-group-title {
  margin: var(--space-4) 2px var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.pp-group-title:first-of-type { margin-top: 0; }

.pp-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 52px;
  padding: var(--space-4);
  border: none;
  background: transparent;
  text-align: left;
  font-family: var(--font-ui);
  color: var(--color-text);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.pp-row:hover { background: var(--color-hover); }
.pp-row .grow {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.pp-id {
  font-size: var(--text-sm);
  font-weight: var(--weight-option-label);
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
.pp-pending {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-warning);
  white-space: nowrap;
}
.pp-chev {
  display: inline-flex;
  flex: none;
  color: var(--color-text-faint);
}

.pp-login-tag {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-accent);
  color: #fff;
  font-size: var(--text-sm);
  font-weight: var(--weight-ui-strong);
  box-shadow: var(--shadow-xs);
}

.pp-empty {
  padding: var(--space-6) var(--space-4);
  text-align: center;
}
.pp-empty-title {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text-faint);
}
.pp-empty-hint {
  margin-top: var(--space-1);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-quaternary);
}

.pp-row.flash { animation: ui-row-flash var(--duration-flash) var(--ease-out); }
</style>
