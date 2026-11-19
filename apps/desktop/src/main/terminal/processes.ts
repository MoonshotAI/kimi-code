import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TerminalActivity } from '../../shared/terminal-activity';

const run = promisify(execFile);

export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid?: number;
  foregroundGroup?: number;
  binary: string;
}

export function binaryName(value: string): string {
  return value.trim().replace(/^\((.+)\)$/, '$1').replace(/\\/g, '/').split('/').at(-1)?.replace(/^-/, '').replace(/\.exe$/i, '') ?? value;
}

export function parseUnixProcesses(output: string): ProcessEntry[] {
  return output.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match || match[5]?.includes('Z')) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), foregroundGroup: Number(match[4]), binary: binaryName(match[6]!) }];
  });
}

export async function readTerminalProcesses(platform: NodeJS.Platform = process.platform): Promise<ProcessEntry[]> {
  if (platform !== 'win32') {
    const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,comm='], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
    return parseUnixProcesses(stdout);
  }
  const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
  { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return parseWindowsProcesses(stdout);
}

export function parseWindowsProcesses(output: string): ProcessEntry[] {
  const data: unknown = JSON.parse(output);
  return (Array.isArray(data) ? data : [data]).flatMap((item: unknown) => {
    if (item === null || typeof item !== 'object') return [];
    const entry = item as Record<string, unknown>;
    if (!Number.isSafeInteger(entry['ProcessId']) || !Number.isSafeInteger(entry['ParentProcessId']) || typeof entry['Name'] !== 'string') return [];
    return [{ pid: entry['ProcessId'] as number, ppid: entry['ParentProcessId'] as number, binary: binaryName(entry['Name']) }];
  });
}

export function terminalActivityOf(
  terminal: { id: string; shell: string; cwd: string; pid?: number },
  entries: ProcessEntry[] | null,
): TerminalActivity {
  const base = { id: terminal.id, binary: terminal.shell, cwd: terminal.cwd, processes: [] };
  const root = entries?.find(entry => entry.pid === terminal.pid);
  if (!entries || !root) return { ...base, state: 'unknown' };
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.ppid) ?? [];
    siblings.push(entry);
    children.set(entry.ppid, siblings);
  }
  const descendants: ProcessEntry[] = [];
  const visited = new Set([root.pid]);
  const queue = [...(children.get(root.pid) ?? [])];
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index]!;
    if (visited.has(entry.pid)) continue;
    visited.add(entry.pid);
    descendants.push(entry);
    queue.push(...(children.get(entry.pid) ?? []));
  }
  const processes = descendants.filter(entry => !['conhost', 'OpenConsole'].includes(entry.binary));
  if (root.binary !== terminal.shell) processes.unshift(root);
  const foreground = processes.filter(entry => root.foregroundGroup !== undefined && entry.pgid === root.foregroundGroup);
  const active = foreground.at(-1) ?? (root.foregroundGroup === undefined ? processes.at(-1) : root);
  return { ...base, state: processes.length > 0 ? 'busy' : 'idle', binary: active?.binary ?? root.binary,
    processes: processes.map(({ pid, binary }) => ({ pid, binary })) };
}
