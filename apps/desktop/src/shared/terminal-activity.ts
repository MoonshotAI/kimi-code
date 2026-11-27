export interface TerminalProcessInfo {
  pid: number;
  binary: string;
}

export interface TerminalActivity {
  id: string;
  state: 'idle' | 'busy' | 'unknown' | 'exited';
  binary: string;
  cwd: string;
  processes: TerminalProcessInfo[];
}

export interface NativeTerminalSshTarget {
  host: string;
  identityFile?: string;
}

export interface NativeTerminalCreateOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  ssh?: NativeTerminalSshTarget;
}

export interface NativeTerminalBridge {
  inspectNativeTerminals?: (ids: string[]) => Promise<TerminalActivity[]>;
  createNativeTerminal: (opts?: NativeTerminalCreateOptions) => Promise<{ id: string; shell: string; cwd: string }>;
  nativeTerminalInput: (id: string, data: string) => void;
  nativeTerminalResize: (id: string, cols: number, rows: number) => void;
  closeNativeTerminal: (id: string) => void;
  onNativeTerminalOutput: (cb: (id: string, data: string) => void) => () => void;
  onNativeTerminalExit: (cb: (id: string, exitCode: number | null) => void) => () => void;
}

export function normalizeTerminalSshTarget(value: unknown): NativeTerminalSshTarget | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw['host'] !== 'string' || raw['host'] === '' || raw['host'].startsWith('-')) return undefined;
  const identityFile = typeof raw['identityFile'] === 'string' && raw['identityFile'] !== '' ? raw['identityFile'] : undefined;
  return identityFile === undefined ? { host: raw['host'] } : { host: raw['host'], identityFile };
}

export function isTerminalActivityList(value: unknown): value is TerminalActivity[] {
  return Array.isArray(value) && value.every(item =>
    item !== null && typeof item === 'object' && typeof item.id === 'string' &&
    ['idle', 'busy', 'unknown', 'exited'].includes(item.state) &&
    typeof item.binary === 'string' && typeof item.cwd === 'string' &&
    Array.isArray(item.processes) && item.processes.every((process: unknown) => {
      if (process === null || typeof process !== 'object') return false;
      const entry = process as Record<string, unknown>;
      return Number.isSafeInteger(entry['pid']) && (entry['pid'] as number) > 0 && typeof entry['binary'] === 'string';
    }),
  );
}
