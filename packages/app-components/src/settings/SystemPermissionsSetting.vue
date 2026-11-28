<script setup lang="ts">
import './settings-common.css';
import './settings-row-label.css';
import { computed, onUnmounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSystemPermissions } from '@moonshot-ai/app-client/composables';
import { Button, Icon, Spinner } from '@moonshot-ai/app-ui';
import SettingsSubpage from './SettingsSubpage.vue';
import SystemPermissionRow from './SystemPermissionRow.vue';
import { useSettingsSubpage } from './useSettingsSubpage';

const props = defineProps<{ scroller?: () => HTMLElement | null | undefined }>();
const emit = defineEmits<{ openChange: [open: boolean] }>();

const { t } = useI18n();
const page = useSettingsSubpage<'systemPermissions'>(() => props.scroller?.());
const open = computed(() => page.page.value !== null);
const permissions = useSystemPermissions();
const { snapshot, loading, busyId, error, hostItems, computerUseItems } = permissions;

watch(open, (value) => {
  emit('openChange', value);
  if (value) void permissions.refresh();
});

onUnmounted(() => emit('openChange', false));

function openPage(origin?: EventTarget | null): void {
  page.open('systemPermissions', origin);
}

function reset(): void {
  page.reset();
}

defineExpose({ reset });
</script>

<template>
  <section v-if="!open" class="sec sp-entry-section">
    <h3 class="sec-title">{{ t('settings.systemPermissions.title') }}</h3>
    <div class="settings-group">
      <button
        type="button"
        class="row sp-entry"
        data-settings-subpage-origin="systemPermissions"
        @click="openPage($event.currentTarget)"
      >
        <span class="settings-row-label">
          {{ t('settings.systemPermissions.title') }}
          <span class="settings-row-hint">{{ t('settings.systemPermissions.entryHint') }}</span>
        </span>
        <span class="sp-entry-chevron"><Icon name="chevron-right" size="sm" /></span>
      </button>
    </div>
  </section>

  <SettingsSubpage
    v-else
    :parent-title="t('settings.tabs.general')"
    :title="t('settings.systemPermissions.title')"
    :description="t('settings.systemPermissions.description')"
    @back="page.back()"
  >
    <div v-if="loading && snapshot === null" class="sp-loading" role="status">
      <Spinner size="sm" />
      <span>{{ t('settings.systemPermissions.loading') }}</span>
    </div>
    <div v-else-if="error !== null && snapshot === null" class="sp-error" role="alert">
      <span>{{ t('settings.systemPermissions.loadFailed') }}</span>
      <Button variant="secondary" size="sm" @click="permissions.refresh">
        {{ t('settings.systemPermissions.retry') }}
      </Button>
    </div>
    <template v-else>
      <p v-if="error !== null" class="sp-action-error" role="alert">
        {{ t('settings.systemPermissions.actionFailed') }}
      </p>
      <section class="sec sp-section">
        <h4 class="sp-group-title">{{ t('settings.systemPermissions.hostGroupTitle') }}</h4>
        <p class="sp-group-hint">{{ t('settings.systemPermissions.hostGroupHint') }}</p>
        <div class="settings-group">
          <SystemPermissionRow
            v-for="item in hostItems"
            :key="item.id"
            :item="item"
            :busy-id="busyId"
            @run="permissions.runAction"
          />
        </div>
      </section>

      <section v-if="computerUseItems.length > 0" class="sec sp-section">
        <h4 class="sp-group-title">{{ t('settings.systemPermissions.cuGroupTitle') }}</h4>
        <p class="sp-group-hint">{{ t('settings.systemPermissions.cuGroupHint') }}</p>
        <div class="settings-group">
          <SystemPermissionRow
            v-for="item in computerUseItems"
            :key="item.id"
            :item="item"
            :busy-id="busyId"
            @run="permissions.runAction"
          />
        </div>
      </section>
    </template>
  </SettingsSubpage>
</template>

<style scoped>
.sp-entry-section {
  padding: var(--space-4) 0;
}
.sp-entry-chevron {
  display: inline-flex;
  flex: none;
  color: var(--color-text-faint);
}
.sp-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 200px;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
}
.sp-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-danger);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
}
.sp-action-error {
  margin: 0 0 var(--space-3);
  color: var(--color-danger);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
}
.sp-section {
  padding-top: var(--space-2);
}
.sp-section + .sp-section {
  margin-top: var(--space-5);
}
.sp-group-title {
  margin: 0;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}
.sp-group-hint {
  margin: var(--space-1) 0 var(--space-3);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
</style>
