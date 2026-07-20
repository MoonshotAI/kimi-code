import { execFile } from 'node:child_process';

export function openUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const command: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  execFile(command[0], command[1], () => {});
}
