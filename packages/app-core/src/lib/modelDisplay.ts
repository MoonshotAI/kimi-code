
import type { AppModel } from '../api/types';
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

export function providerDisplayName(providerId: string, t: (key: string) => string): string {
  return providerId === MANAGED_KIMI_CODE_PROVIDER_ID ? t('providers.kimiSubscription') : providerId;
}
