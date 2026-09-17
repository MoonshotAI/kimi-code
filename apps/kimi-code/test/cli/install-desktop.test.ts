import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KimiRegionProfile } from '@moonshot-ai/kimi-code-oauth';

import { registerInstallDesktopCommand } from '#/cli/sub/install-desktop';

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
  currentKimiProfile: vi.fn(() => ({ siteBase: 'https://example.com' }) as unknown as KimiRegionProfile),
}));

vi.mock('#/utils/open-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/open-url')>();
  return { ...actual, openUrl: mocks.openUrl };
});

vi.mock('#/utils/region', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/region')>();
  return { ...actual, currentKimiProfile: mocks.currentKimiProfile };
});

describe('kimi install-desktop', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the region-derived desktop app page URL and opens it in the browser', async () => {
    const program = new Command('kimi');
    registerInstallDesktopCommand(program);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await program.parseAsync(['node', 'kimi', 'install-desktop']);

    expect(write).toHaveBeenCalledWith('https://example.com/code\n');
    expect(mocks.openUrl).toHaveBeenCalledWith('https://example.com/code');
  });

  it('keeps install-app working as a hidden alias', async () => {
    const program = new Command('kimi');
    registerInstallDesktopCommand(program);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await program.parseAsync(['node', 'kimi', 'install-app']);

    expect(write).toHaveBeenCalledWith('https://example.com/code\n');
    expect(mocks.openUrl).toHaveBeenCalledWith('https://example.com/code');
  });
});
