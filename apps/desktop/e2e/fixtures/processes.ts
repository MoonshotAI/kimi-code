import { spawnSync } from 'node:child_process';
import type { ElectronApplication } from '@playwright/test';

export const CLOSE_TIMEOUT_MS = 15_000;

interface WindowsProcess {
  readonly pid: number;
  readonly parent: number;
  readonly created: string;
  readonly name: string;
}

interface CloseResult {
  readonly error: string | null;
  readonly leftovers: string[];
}

function windowsProcesses(): WindowsProcess[] {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "{0} {1} {2} {3}" -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }), $_.Name }';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return (result.stdout ?? '').split(/\r?\n/).flatMap((line) => {
    const match = /^(\d+) (\d+) (\d+) (.*)$/.exec(line.trim());
    return match === null ? [] : [{ pid: Number(match[1]), parent: Number(match[2]), created: match[3]!, name: match[4]! }];
  });
}

export function windowsDescendants(root: number): WindowsProcess[] {
  const table = windowsProcesses();
  const rootProcess = table.find(entry => entry.pid === root);
  if (rootProcess === undefined) return [];
  const found: WindowsProcess[] = [];
  const queue = [rootProcess];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const child of table) {
      if (child.parent === parent.pid && child.pid !== parent.pid && BigInt(child.created) >= BigInt(parent.created) && !found.includes(child)) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { return; }
  }
}

export function killSurvivors(tree: readonly WindowsProcess[]): string[] {
  if (tree.length === 0) return [];
  const alive = new Set(windowsProcesses().map(entry => `${entry.pid} ${entry.created}`));
  const survivors = tree.filter(entry => alive.has(`${entry.pid} ${entry.created}`));
  for (const entry of survivors) killProcessTree(entry.pid);
  return survivors.map(entry => entry.name);
}

export function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), ms); });
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

export async function closeApp(electron: ElectronApplication): Promise<CloseResult> {
  const child = electron.process();
  const pid = child.pid;
  const tree = process.platform === 'win32' && pid !== undefined ? windowsDescendants(pid) : [];
  const exitedEarly = child.exitCode !== null || child.signalCode !== null;
  const exited = exitedEarly
    ? Promise.resolve('exited' as const)
    : new Promise<'exited'>(resolve => child.once('exit', () => resolve('exited')));
  const closed = electron.close().then(() => null, (error: unknown) => String(error));
  const exit = await within(exited, CLOSE_TIMEOUT_MS);
  if (pid !== undefined) killProcessTree(pid);
  const leftovers = killSurvivors(tree);
  if (exit === 'timeout') return { error: `Electron did not exit within ${CLOSE_TIMEOUT_MS} ms; its process tree was killed.`, leftovers };
  for (const stream of child.stdio) stream?.destroy();
  const closeError = await within(closed, CLOSE_TIMEOUT_MS);
  if (closeError === 'timeout') {
    return { error: `Playwright did not settle ${CLOSE_TIMEOUT_MS} ms after Electron exited (exit code ${child.exitCode}, signal ${child.signalCode}) and its pipes were closed.`, leftovers };
  }
  const status = child.signalCode !== null ? `signal ${child.signalCode}` : `exit code ${child.exitCode}`;
  if (exitedEarly) return { error: `Electron exited with ${status} before teardown closed it.`, leftovers };
  if (child.exitCode !== 0) return { error: `Electron exited with ${status} during teardown.`, leftovers };
  if (closeError !== null) return { error: `Closing Electron failed: ${closeError}`, leftovers };
  return { error: null, leftovers };
}

export function windowsLoad(): string[] {
  if (process.platform !== 'win32') return [];
  const script = 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 12 | ForEach-Object { "{0} pid {1} cpu {2:N1}s" -f $_.ProcessName, $_.Id, $_.CPU }';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return (result.stdout ?? '').split(/\r?\n/).filter(line => line.trim() !== '');
}
