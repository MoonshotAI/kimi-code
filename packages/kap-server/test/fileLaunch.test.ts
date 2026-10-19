import { describe, expect, it } from 'vitest';

import { openInAppCommandFor, revealFileCommandFor } from '../src/lib/fileLaunch';

describe('fileLaunch', () => {
  describe('win32 explorer /select, quoting', () => {
    it('revealFileCommandFor quotes only the path and uses verbatim arguments', () => {
      const cmd = revealFileCommandFor('C:\\some dir\\sub\\file.txt', 'win32');
      expect(cmd.command).toBe('explorer.exe');
      expect(cmd.args).toEqual(['/select,"C:\\some dir\\sub\\file.txt"']);
      expect(cmd.windowsVerbatimArguments).toBe(true);
    });

    it('openInAppCommandFor (finder) quotes only the path and uses verbatim arguments', () => {
      const cmd = openInAppCommandFor(
        'finder',
        'C:\\some dir\\sub\\file.txt',
        { isDirectory: false },
        'win32',
      );
      expect(cmd.command).toBe('explorer.exe');
      expect(cmd.args).toEqual(['/select,"C:\\some dir\\sub\\file.txt"']);
      expect(cmd.windowsVerbatimArguments).toBe(true);
    });

    it('openInAppCommandFor (finder) opens directories without /select,', () => {
      const cmd = openInAppCommandFor(
        'finder',
        'C:\\some dir\\sub',
        { isDirectory: true },
        'win32',
      );
      expect(cmd.command).toBe('explorer.exe');
      expect(cmd.args).toEqual(['C:\\some dir\\sub']);
      expect(cmd.windowsVerbatimArguments).toBeUndefined();
    });

    it('drops a trailing backslash so it cannot escape the closing quote', () => {
      const cmd = revealFileCommandFor('C:\\some dir\\sub\\', 'win32');
      expect(cmd.args).toEqual(['/select,"C:\\some dir\\sub"']);
    });

    it('paths without spaces keep the same quoting', () => {
      const cmd = revealFileCommandFor('C:\\proj\\file.txt', 'win32');
      expect(cmd.args).toEqual(['/select,"C:\\proj\\file.txt"']);
      expect(cmd.windowsVerbatimArguments).toBe(true);
    });
  });
});
