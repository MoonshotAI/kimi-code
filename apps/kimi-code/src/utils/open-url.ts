import { execFile } from 'node:child_process';

// `windowsHide` is ignored off Windows (kept unconditional, matching kaos).
// Without it, a console-less parent (e.g. a GUI-launched `kimi web`) makes
// Windows allocate a visible console for the transient `cmd /c start`.
const SPAWN_OPTIONS = { windowsHide: true } as const;

export function openUrl(url: string): void {
  const command: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  execFile(command[0], command[1], SPAWN_OPTIONS, () => {});
}
