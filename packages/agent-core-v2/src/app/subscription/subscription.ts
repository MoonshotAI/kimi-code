import { IConfigService } from '#/app/config/config';

import { SUBSCRIPTION_SECTION } from './configSection';

export { SUBSCRIPTION_SECTION } from './configSection';

export type SubscriptionMethodId = 'web_search' | 'fetch_url' | 'auto_session_title';

export function isSubscriptionMethodEnabled(
  config: IConfigService,
  id: SubscriptionMethodId,
): boolean {
  const section = config.get(SUBSCRIPTION_SECTION) as Record<string, boolean> | undefined;
  return section?.[id] !== false;
}
