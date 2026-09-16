import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerInstallAppCommand } from '#/cli/sub/install-app';
import { DESKTOP_WEBSITE_URL } from '#/constant/app';

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
}));

vi.mock('#/utils/open-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/open-url')>();
  return { ...actual, openUrl: mocks.openUrl };
});

describe('kimi install-app', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the desktop website URL and opens it in the browser', async () => {
    const program = new Command('kimi');
    registerInstallAppCommand(program);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await program.parseAsync(['node', 'kimi', 'install-app']);

    expect(write).toHaveBeenCalledWith(`${DESKTOP_WEBSITE_URL}\n`);
    expect(mocks.openUrl).toHaveBeenCalledWith(DESKTOP_WEBSITE_URL);
  });
});
