import {
  resolveExperimentalSurface,
  type HostUiCapability,
  type IBootstrapService,
} from '#/app/bootstrap/bootstrap';
import type { IFlagService } from '#/app/flag/flag';
import type { ExperimentalSurface, FlagId } from '#/app/flag/flagRegistry';

import { NOTIFY_USER_APP_FLAG_ID, NOTIFY_USER_FLAG_ID } from './flag';

export const NOTIFY_USER_UI_CAPABILITY: HostUiCapability = 'update_panel';

export function notifyUserFlagIdForSurface(surface: ExperimentalSurface): FlagId {
  return surface === 'tui' ? NOTIFY_USER_FLAG_ID : NOTIFY_USER_APP_FLAG_ID;
}

export function notifyUserAvailable(flags: IFlagService, bootstrap: IBootstrapService): boolean {
  const surface = resolveExperimentalSurface(bootstrap.clientIdentity, bootstrap.args.surface);
  if (!flags.enabled(notifyUserFlagIdForSurface(surface))) return false;
  return (bootstrap.args.uiCapabilities ?? []).includes(NOTIFY_USER_UI_CAPABILITY);
}
