import { spawn } from 'node:child_process';

export interface RevealCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export function revealCommandFor(path: string, platform: NodeJS.Platform = process.platform): RevealCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [path] };
    case 'win32':
      return { command: 'cmd', args: ['/c', 'start', '""', path] };
    default:
      return { command: 'xdg-open', args: [path] };
  }
}

export async function revealInOs(path: string): Promise<void> {
  const { command, args } = revealCommandFor(path);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}
