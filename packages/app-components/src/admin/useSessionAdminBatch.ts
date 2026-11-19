import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { planAdminBatchToast, type SessionAdminBatchDirection } from '@moonshot-ai/app-client/client';

export function useSessionAdminBatch() {
  const client = useKimiWebClient();
  const { t } = useI18n();

  const sessionAdminBatchRunning = ref<SessionAdminBatchDirection | null>(null);

  async function runSessionAdminBatch(direction: SessionAdminBatchDirection, ids: string[]): Promise<void> {
    if (ids.length === 0 || sessionAdminBatchRunning.value !== null) return;
    sessionAdminBatchRunning.value = direction;
    try {
      const outcome =
        direction === 'archive' ? await client.archiveSessions(ids) : await client.restoreSessions(ids);
      const plan = planAdminBatchToast(direction, outcome);
      if (plan === null) {
        client.notify({
          severity: 'error',
          title: t(
            direction === 'archive' ? 'admin.batchDoneFailedNotice' : 'admin.batchReopenFailedNotice',
            { n: outcome.failed },
          ),
        });
        return;
      }
      client.showActionToast({ kind: 'adminBatch', plan });
    } finally {
      sessionAdminBatchRunning.value = null;
    }
  }

  return { sessionAdminBatchRunning, runSessionAdminBatch };
}
