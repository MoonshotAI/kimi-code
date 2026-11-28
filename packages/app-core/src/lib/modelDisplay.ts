
import type { AppModel, AppProvider } from '../api/types';
import { MANAGED_KIMI_CODE_PROVIDER_ID } from '../api/types';
import { effortLabel } from './modelThinking';

export function modelDisplayName(
  alias: string | undefined,
  models: readonly AppModel[] | undefined,
): string | undefined {
  if (alias === undefined || alias.length === 0) return undefined;
  const matched = models?.find((m) => m.id === alias) ?? models?.find((m) => m.model === alias);
  return (
    matched?.displayName ||
    matched?.model ||
    (alias.includes('/') ? alias.split('/').pop()! : alias)
  );
}

export function subagentEffortSuffix(effort: string | undefined): string | undefined {
  if (effort === undefined || effort.length === 0 || effort === 'off' || effort === 'on') {
    return undefined;
  }
  return effortLabel(effort);
}

export function providerDisplayName(
  providerId: string,
  t: (key: string) => string,
  providers?: readonly Pick<AppProvider, 'id' | 'displayName'>[],
): string {
  const displayName = providers?.find((provider) => provider.id === providerId)?.displayName;
  if (displayName !== undefined && displayName !== '') return displayName;
  return providerId === MANAGED_KIMI_CODE_PROVIDER_ID ? t('providers.kimiSubscription') : providerId;
}
