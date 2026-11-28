<script setup lang="ts">
import './settings-common.css';
import './settings-row-label.css';
import { useI18n } from 'vue-i18n';
import type { SystemPermissionId, SystemPermissionItem } from '@moonshot-ai/app-core/system-permissions';
import { Badge, Button } from '@moonshot-ai/app-ui';
import { SYSTEM_PERMISSION_COPY, SYSTEM_PERMISSION_STATUS_COPY, systemPermissionExtraHintKey } from './systemPermissionsLabels';

const props = defineProps<{
  item: SystemPermissionItem;
  busyId: SystemPermissionId | null;
}>();
const emit = defineEmits<{ run: [item: SystemPermissionItem] }>();

const { t } = useI18n();

function actionLabel(): string {
  return t(props.item.action === 'request' ? 'settings.systemPermissions.request' : 'settings.systemPermissions.openSettings');
}
</script>

<template>
  <div class="row sp-row" :data-permission-id="item.id">
    <span class="settings-row-label sp-row-label">
      <span class="sp-row-title">{{ t(SYSTEM_PERMISSION_COPY[item.id].title) }}</span>
      <span class="settings-row-hint">{{ t(SYSTEM_PERMISSION_COPY[item.id].hint) }}</span>
      <span v-if="systemPermissionExtraHintKey(item)" class="settings-row-hint sp-row-note">
        {{ t(systemPermissionExtraHintKey(item)!) }}
      </span>
    </span>
    <span class="sp-row-actions">
      <Badge :variant="SYSTEM_PERMISSION_STATUS_COPY[item.status].variant" size="sm" dot>
        {{ t(SYSTEM_PERMISSION_STATUS_COPY[item.status].key) }}
      </Badge>
      <Button
        v-if="item.action !== null"
        variant="secondary"
        size="sm"
        :loading="busyId === item.id"
        :disabled="busyId !== null"
        @click="emit('run', item)"
      >
        {{ actionLabel() }}
      </Button>
    </span>
  </div>
</template>

<style scoped>
.sp-row {
  align-items: center;
  gap: var(--space-4);
}
.sp-row-label {
  gap: var(--space-1);
  min-width: 0;
  font-weight: var(--weight-regular);
}
.sp-row-title {
  color: var(--color-text);
  font-weight: var(--weight-option-label);
}
.sp-row-label .sp-row-note {
  color: var(--color-text-faint);
}
.sp-row-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
}
@media (max-width: 640px) {
  .sp-row {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--space-2);
  }
  .sp-row-actions {
    align-self: flex-end;
  }
}
</style>
