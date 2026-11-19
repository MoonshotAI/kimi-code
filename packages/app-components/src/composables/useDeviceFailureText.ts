import { useI18n } from 'vue-i18n';
import type { AppDeviceConnectFailure } from '@moonshot-ai/app-core/api';
import type { DeviceInstall } from '@moonshot-ai/app-client/stores';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';

const HINTED_FAILURES: ReadonlySet<AppDeviceConnectFailure> = new Set([
  'host_not_found',
  'connection_refused',
  'host_unreachable',
  'connect_timeout',
  'authentication_failed',
  'host_key_changed',
  'executor_not_found',
  'outdated',
  'remote_busy',
  'remote_start_failed',
]);

export interface DeviceFailureContext {
  readonly host?: string;
  readonly name?: string;
  readonly install?: DeviceInstall;
}

export function useDeviceFailureText(): {
  label: (failure: AppDeviceConnectFailure | undefined, remoteVersion?: string) => string;
  hint: (failure: AppDeviceConnectFailure | undefined, context?: DeviceFailureContext) => string;
  confirmCopy: (device: string) => Promise<boolean>;
} {
  const { t } = useI18n();
  const { confirm } = useConfirmDialog();
  return {
    label(failure, remoteVersion) {
      if (failure === undefined || failure === 'unknown') return '';
      if (failure === 'outdated' && remoteVersion !== undefined && remoteVersion !== 'unknown') {
        return t('workspace.connectFailureOutdatedVersion', { version: remoteVersion });
      }
      return t(`workspace.connectFailure.${failure}`);
    },
    hint(failure, context = {}) {
      if (failure === undefined || !HINTED_FAILURES.has(failure)) return '';
      const name = context.name || context.host;
      if (failure === 'outdated' && context.install === 'desktop') {
        return t('workspace.connectFailureHintDesktopOutdated', { name });
      }
      return t(`workspace.connectFailureHint.${failure}`, { host: context.host, name });
    },
    confirmCopy(device) {
      return confirm({
        title: t('settings.devices.copyConfirmTitle', { device }),
        message: t('settings.devices.copyConfirmMessage'),
        confirmLabel: t('settings.devices.copyConfirm'),
      });
    },
  };
}
