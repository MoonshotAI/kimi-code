import { DESKTOP_WEBSITE_URL } from '#/constant/app';
import { openUrl } from '#/utils/open-url';

import type { SlashCommandHost } from './dispatch';

export async function handleDesktopCommand(host: SlashCommandHost): Promise<void> {
  host.showStatus(`${DESKTOP_WEBSITE_URL} — opened in your browser`);
  openUrl(DESKTOP_WEBSITE_URL);
}
