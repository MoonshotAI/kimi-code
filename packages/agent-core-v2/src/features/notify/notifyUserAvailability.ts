import type { HostUiCapability } from '#/app/bootstrap/bootstrap';
import type { IClientIdentity } from '#/app/clientIdentity/clientIdentity';
import type { IFlagService } from '#/app/flag/flag';

import { NOTIFY_USER_FLAG_ID } from './flag';

export const NOTIFY_USER_UI_CAPABILITY: HostUiCapability = 'update_panel';

export function notifyUserAvailable(flags: IFlagService, client: IClientIdentity): boolean {
  if (!flags.enabled(NOTIFY_USER_FLAG_ID)) return false;
  return (client.uiCapabilities ?? []).includes(NOTIFY_USER_UI_CAPABILITY);
}
