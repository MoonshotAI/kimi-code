import { execFile } from 'node:child_process';

import { resolveCommandPath } from '#/utils/process/resolve-command';

export function openUrl(url: string, onError?: (error: Error) => void, trustedCwd?: string): void {
  const command: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(
          `try { Start-Process -FilePath '${url.replaceAll("'", "''")}' -ErrorAction Stop } catch { exit 1 }`,
          'utf16le',
        ).toString('base64')]]
        : ['xdg-open', [url]];
  const executable = resolveCommandPath(command[0], trustedCwd, { trusted: trustedCwd !== undefined });
  if (executable === undefined) {
    onError?.(new Error(`Cannot find ${command[0]}`));
    return;
  }
  execFile(executable, command[1], { windowsHide: true }, (error) => {
    if (error) onError?.(error);
  });
}
