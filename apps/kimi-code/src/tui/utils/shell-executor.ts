import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { constants } from 'node:os';
import type { TUI } from '@earendil-works/pi-tui';

async function promptToContinue(): Promise<void> {
  process.stdout.write('\n\n[Press Enter to return to Kimi Code]\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

export async function runShellCommand(command: string, ui: TUI): Promise<number> {
  ui.stop();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(command, { shell: true, stdio: 'inherit' });
      child.on('exit', (code, signal) => {
        if (code !== null) {
          resolve(code);
        } else if (signal !== null) {
          const signum = constants.signals[signal] ?? 1;
          resolve(128 + signum);
        } else {
          resolve(0);
        }
      });
      child.on('error', reject);
    });
    return code;
  } finally {
    await promptToContinue();
    try {
      if (typeof process.stdin.pause === 'function') {
        process.stdin.pause();
      }
    } catch {
      // ignore
    }
    ui.start();
    ui.requestRender(true);
  }
}
