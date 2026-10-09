import { afterEach, expect, it, vi } from 'vitest';

import { openUrl } from '#/utils/open-url';
import { execFile } from 'node:child_process';
import { resolveCommandPath } from '#/utils/process/resolve-command';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('#/utils/process/resolve-command', () => ({ resolveCommandPath: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

it.each([
  ['darwin', 'open', []],
  ['linux', 'xdg-open', []],
])('opens URLs as one argument on %s using an absolute executable', (platform, command, args) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform as NodeJS.Platform);
  vi.mocked(resolveCommandPath).mockReturnValue(`/system/${command}`);
  const url = 'kimi-code://open?root=%2Ftmp%2Fa%25NAME%25%26b&new=1';
  openUrl(url);
  expect(resolveCommandPath).toHaveBeenCalledWith(command);
  expect(execFile).toHaveBeenCalledWith(`/system/${command}`, [...args, url], { windowsHide: true }, expect.any(Function));
});

it('reports a missing opener without spawning a bare command', () => {
  vi.mocked(resolveCommandPath).mockReturnValue(undefined);
  const onError = vi.fn();
  openUrl('kimi-code://open?root=/tmp', onError);
  expect(onError).toHaveBeenCalledWith(expect.any(Error));
  expect(execFile).not.toHaveBeenCalled();
});

it('reports OS opener failures', () => {
  vi.mocked(resolveCommandPath).mockReturnValue('/system/open');
  const onError = vi.fn();
  openUrl('kimi-code://open?root=/tmp', onError);
  const callback = vi.mocked(execFile).mock.calls[0]![3] as (error: Error) => void;
  const error = new Error('no scheme handler');
  callback(error);
  expect(onError).toHaveBeenCalledWith(error);
});

it('uses a failure-reporting Windows opener and quotes URLs as literal strings', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.mocked(resolveCommandPath).mockReturnValue('/system/powershell.exe');
  const url = "kimi-code://open?root=C%3A%5Ctest's%26%25&new=1";
  openUrl(url);
  expect(resolveCommandPath).toHaveBeenCalledWith('powershell.exe');
  const call = vi.mocked(execFile).mock.calls[0]!;
  const args = call[1] as string[];
  expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  expect(Buffer.from(args[3]!, 'base64').toString('utf16le')).toBe(
    "try { Start-Process -FilePath 'kimi-code://open?root=C%3A%5Ctest''s%26%25&new=1' -ErrorAction Stop } catch { exit 1 }",
  );
  expect(call[2]).toEqual({ windowsHide: true });
});
