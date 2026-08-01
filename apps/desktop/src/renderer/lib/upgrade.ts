// apps/web/src/lib/upgrade.ts
// The single managed-account upgrade entry, shared by the sidebar user menu,
// the composer's no-usable-model pill, and the settings account tab. Free
// managed accounts (userinfo probe rejected with 402, see ManagedMembership)
// get this link in place of the plan-usage UI.

import { isDesktop } from './desktopFlag';

/** Upgrade landing page; the `from` param identifies the host app. */
export const UPGRADE_URL = `https://www.kimi.com/code?from=${isDesktop ? 'kimi_code_desktop' : 'kimi_code_web'}`;

export function openUpgrade(): void {
  window.open(UPGRADE_URL, '_blank', 'noopener');
}
