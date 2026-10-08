import { execFile } from 'node:child_process';

import { resolveCommandPath } from '#/utils/process/resolve-command';

export function openUrl(url: string, onError?: (error: Error) => void): void {
  const command: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  const executable = resolveCommandPath(command[0]);
  if (executable === undefined) {
    onError?.(new Error(`Cannot find ${command[0]}`));
    return;
  }
  execFile(executable, command[1], (error) => {
    if (error) onError?.(error);
  });
}
