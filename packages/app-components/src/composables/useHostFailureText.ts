import { useI18n } from 'vue-i18n';
import type { AppHostConnectFailure } from '@moonshot-ai/app-core/api';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';

export function useHostFailureText(): {
  label: (failure: AppHostConnectFailure | undefined, remoteVersion?: string) => string;
  hint: (failure: AppHostConnectFailure | undefined, host?: string, name?: string) => string;
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
    hint(failure, host, name) {
      return failure !== undefined && failure !== 'unknown'
        ? t(`workspace.connectFailureHint.${failure}`, { host, name: name || host })
        : '';
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
