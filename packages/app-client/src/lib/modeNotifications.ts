import { t } from '../client/deps';
import { warningsStore } from '../stores/warnings';

export function notifySwarmModeEnabled(): void {
  warningsStore().pushWarning({
    severity: 'warning',
    title: t('workspace.swarmEnabledTitle'),
    message: t('workspace.swarmEnabledMessage'),
  });
}
