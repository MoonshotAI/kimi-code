import type { HostUiCapability, IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IFlagService } from '#/app/flag/flag';

import { NOTIFY_USER_FLAG_ID } from './flag';

export const NOTIFY_USER_UI_CAPABILITY: HostUiCapability = 'update_panel';

export function notifyUserAvailable(flags: IFlagService, bootstrap: IBootstrapService): boolean {
  if (!flags.enabled(NOTIFY_USER_FLAG_ID)) return false;
  return (bootstrap.args.uiCapabilities ?? []).includes(NOTIFY_USER_UI_CAPABILITY);
}
