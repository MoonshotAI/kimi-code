import { spawnSync } from 'node:child_process';

export function killProcessTree(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new RangeError('Expected a child process ID');
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { return; }
  }
}
