import { describe, expect, it, vi } from 'vitest';

import { DESKTOP_WEBSITE_URL } from '#/constant/app';
import { handleDesktopCommand } from '#/tui/commands/desktop';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
}));

vi.mock('#/utils/open-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/open-url')>();
  return { ...actual, openUrl: mocks.openUrl };
});

describe('handleDesktopCommand', () => {
  it('shows the desktop website URL and opens it in the browser', async () => {
    const host = { showStatus: vi.fn() } as unknown as SlashCommandHost;

    await handleDesktopCommand(host);

    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining(DESKTOP_WEBSITE_URL));
    expect(mocks.openUrl).toHaveBeenCalledWith(DESKTOP_WEBSITE_URL);
  });
});
