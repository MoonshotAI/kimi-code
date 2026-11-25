import { execFileSync } from 'node:child_process';
import os from 'node:os';

export interface ProcessStamp {
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (process.platform === 'win32') return true;
  try {
    const stat = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
      timeout: 1000,
    });
    return !stat.trim().startsWith('Z');
  } catch {
    return true;
  }
}

export function processStampAlive(stamp: ProcessStamp, hostname = os.hostname()): boolean {
  if (stamp.hostname !== '' && stamp.hostname !== hostname) return true;
  if (!pidAlive(stamp.pid)) return false;
  const bootTime = Date.now() - os.uptime() * 1000;
  return stamp.startedAt >= bootTime;
}
