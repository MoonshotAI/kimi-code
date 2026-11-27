<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppProvider } from '@moonshot-ai/app-core/api';
import { providerModelRows } from '@moonshot-ai/app-core/lib';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { Badge, Button, Icon, IconButton } from '@moonshot-ai/app-ui';
import ProviderBrandIcon from './ProviderBrandIcon.vue';

const props = defineProps<{
  provider?: AppProvider;
}>();

const emit = defineEmits<{
  cancel: [];
  login: [];
}>();

const { t } = useI18n();
const client = useKimiWebClient();

const signedIn = computed(() => client.managedProviderStatus.value === 'authenticated');
const accountName = computed(() => {
  const info = client.managedUserInfo.value;
  return info?.nickname || info?.email || '';
});

const models = computed(() =>
  props.provider === undefined
    ? []
    : providerModelRows(props.provider, client.config.value?.models),
);

const refreshing = ref(false);
async function refreshModels(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    const result = await client.refreshOAuthProviderModels();
    if (result.ok) {
      client.notify({ severity: 'success', title: t('providers.refreshModelsDone') });
    } else {
      client.notify({ severity: 'error', title: t('providers.refreshModelsFailed') });
    }
  } finally {
    refreshing.value = false;
  }
}

function formatContext(size: string): string {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return size;
  if (n >= 1048576) return `${Math.round(n / 1048576)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return size;
}
</script>

<template>
  <div class="mpv">
    <div class="mpv-head">
      <IconButton class="mpv-nav" size="sm" :label="t('settings.plugins.back')" @click="emit('cancel')">
        <Icon name="arrow-left" size="sm" />
      </IconButton>
      <ProviderBrandIcon v-if="props.provider" :id="props.provider.id" size="sm" />
      <span class="mpv-title">{{ t('providers.kimiSubscription') }}</span>
      <Badge variant="neutral" size="sm">{{ t('providers.managedBuiltin') }}</Badge>
      <Badge v-if="signedIn" variant="info" size="sm">{{ t('providers.managedBadge') }}</Badge>
    </div>

    <div v-if="signedIn" class="mpv-body">
      <div class="settings-group settings-group-divided">
        <div class="mpv-row">
          <span class="mpv-label">{{ t('providers.managedAccount') }}</span>
          <span class="mpv-value">{{ accountName }}</span>
        </div>
        <div class="mpv-row">
          <span class="mpv-label">{{ t('providers.managedAccessMode') }}</span>
          <span class="mpv-value">{{ t('providers.managedOauth') }}</span>
        </div>
        <div class="mpv-row mpv-row-models">
          <span class="mpv-label">{{ t('providers.availableModels', { count: models.length }) }}</span>
          <div class="mpv-chips">
            <span v-for="m in models" :key="m.model" class="mpv-chip">
              {{ m.model }}
              <span v-if="formatContext(m.maxContextSize)" class="mpv-chip-ctx">{{ formatContext(m.maxContextSize) }}</span>
            </span>
          </div>
        </div>
      </div>
      <div class="mpv-actions">
        <Button variant="secondary" size="sm" :disabled="refreshing" @click="refreshModels">
          <Icon name="refresh" size="sm" />
          {{ t('providers.refreshModels') }}
        </Button>
      </div>
      <div class="mpv-note">
        <Icon name="info" size="sm" />
        {{ t('providers.managedReadonly') }}
      </div>
    </div>

    <div v-else class="mpv-body">
      <div class="settings-group settings-group-divided">
        <div class="mpv-row mpv-row-login">
          <span class="mpv-label">
            {{ t('providers.managedLoginTitle') }}
            <span class="mpv-hint">{{ t('providers.managedLoginHint') }}</span>
          </span>
          <Button variant="primary" size="sm" @click="emit('login')">
            {{ t('providers.loginAction') }}
          </Button>
        </div>
        <div class="mpv-row">
          <span class="mpv-label">{{ t('providers.availableModelsLabel') }}</span>
          <span class="mpv-value mpv-value-faint">{{ t('providers.loginToSeeModels') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped src="./settings-common.css"></style>

<style scoped>
.mpv { display: flex; flex-direction: column; }
.mpv-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}
.mpv-nav { margin-left: calc(-1 * var(--space-2)); }
.mpv-title {
  font-family: var(--font-ui);
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.mpv-body { display: flex; flex-direction: column; }

.mpv-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 52px;
  padding: var(--space-4);
}
.mpv-row-models { flex-direction: column; align-items: flex-start; gap: var(--space-3); }
.mpv-row-login { align-items: center; }
.mpv-label {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-option-label);
  color: var(--color-text);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mpv-hint {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  font-weight: var(--weight-regular);
}
.mpv-value {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.mpv-value-faint { color: var(--color-text-faint); }

.mpv-chips { display: flex; flex-wrap: wrap; gap: var(--space-1-5); }
.mpv-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 24px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-fill-1);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.mpv-chip-ctx { color: var(--color-text-quaternary); }

.mpv-actions { display: flex; gap: var(--space-2); margin-top: var(--space-4); }
.mpv-note {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-4);
  color: var(--color-text-quaternary);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
}
</style>
