import { useI18n } from 'vue-i18n';
import type { AppHostConnectFailure } from '@moonshot-ai/app-core/api';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';

const HINTED_FAILURES: ReadonlySet<AppHostConnectFailure> = new Set([
  'executor_not_found',
  'executor_outdated',
  'remote_busy',
  'remote_start_failed',
]);

export function isKimiHostFailure(failure: AppHostConnectFailure | undefined): boolean {
  return failure !== undefined && HINTED_FAILURES.has(failure);
}

export function useHostFailureText(): {
  label: (failure: AppHostConnectFailure | undefined, remoteVersion?: string) => string;
  hint: (failure: AppHostConnectFailure | undefined) => string;
  confirmCopy: (host: string) => Promise<boolean>;
} {
  const { t } = useI18n();
  const { confirm } = useConfirmDialog();
  return {
    label(failure, remoteVersion) {
      if (failure === undefined || failure === 'unknown') return '';
      if (failure === 'executor_outdated' && remoteVersion !== undefined && remoteVersion !== 'unknown') {
        return t('workspace.connectFailureOutdatedVersion', { version: remoteVersion });
      }
      return t(`workspace.connectFailure.${failure}`);
    },
    hint(failure) {
      return failure !== undefined && HINTED_FAILURES.has(failure) ? t(`workspace.connectFailureHint.${failure}`) : '';
    },
    confirmCopy(host) {
      return confirm({
        title: t('settings.hosts.copyConfirmTitle', { host }),
        message: t('settings.hosts.copyConfirmMessage'),
        confirmLabel: t('settings.hosts.copyConfirm'),
      });
    },
  };
}
