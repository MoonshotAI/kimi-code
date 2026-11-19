import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

export type LidActions = { ac: number; dc: number };
type Plan = LidActions & { owners: string[] };
type State = { version: 1; plans: Record<string, Plan>; released: string[] };

function statePath(): string {
  if (!process.env['LOCALAPPDATA']) throw new Error('LOCALAPPDATA is unavailable');
  return join(process.env['LOCALAPPDATA'], 'Kimi Code', 'power-management', 'lid.json');
}

function ownerId(): string {
  return createHash('sha256').update(normalize(app.getPath('userData')).toLowerCase()).update('\0')
    .update(normalize(app.isPackaged ? dirname(process.execPath) : app.getAppPath()).toLowerCase()).digest('hex');
}

export class WindowsLidState {
  private state: State;

  constructor(private file: string, private owner: string) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as State;
      if (value?.version !== 1 || !Array.isArray(value.released) || value.released.some((v) => typeof v !== 'string') || !value.plans || typeof value.plans !== 'object' || Array.isArray(value.plans)
        || Object.entries(value.plans).some(([id, plan]) => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
          || !plan || ![plan.ac, plan.dc].every((v) => Number.isInteger(v) && v >= 0 && v <= 3)
          || !Array.isArray(plan.owners) || !plan.owners.length || plan.owners.some((v) => typeof v !== 'string' || !v))) {
        throw new Error('Invalid shared power scheme backups');
      }
      this.state = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { version: 1, plans: {}, released: [] };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(this.state), { flush: true });
      renameSync(temporary, this.file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  migrate(backups: Record<string, LidActions>): void {
    for (const [id, original] of Object.entries(backups)) {
      const existing = this.state.plans[id];
      if (existing && (existing.ac !== original.ac || existing.dc !== original.dc)) {
        throw new Error('Conflicting legacy power scheme backups; manual recovery is required');
      }
    }
    for (const [id, original] of Object.entries(backups)) this.addOwner(id, original);
    if (Object.keys(backups).length) this.save();
  }

  private addOwner(id: string, original: LidActions): void {
    this.state.released = this.state.released.filter((owner) => owner !== this.owner);
    const plan = this.state.plans[id] ??= { ...original, owners: [] };
    if (!plan.owners.includes(this.owner)) plan.owners.push(this.owner);
  }

  claim(id: string, original: LidActions): void {
    this.addOwner(id, original);
    this.save();
  }

  owned(): Record<string, LidActions> {
    return Object.fromEntries(Object.entries(this.state.plans).filter(([, plan]) => plan.owners.includes(this.owner))
      .map(([id, { ac, dc }]) => [id, { ac, dc }]));
  }

  restorable(): Record<string, LidActions> {
    return Object.fromEntries(Object.entries(this.state.plans).filter(([, plan]) => plan.owners.length === 1 && plan.owners[0] === this.owner)
      .map(([id, { ac, dc }]) => [id, { ac, dc }]));
  }

  release(): void {
    for (const [id, plan] of Object.entries(this.state.plans)) {
      plan.owners = plan.owners.filter((owner) => owner !== this.owner);
      if (!plan.owners.length) delete this.state.plans[id];
    }
    if (!this.state.released.includes(this.owner)) this.state.released.push(this.owner);
    this.save();
  }

  wasReleased(): boolean {
    return this.state.released.includes(this.owner);
  }
}

export async function withWindowsLidLock<T>(operation: () => Promise<T>, key = statePath()): Promise<T> {
  const hash = createHash('sha256').update(key.toLowerCase()).digest('hex');
  const script = `$ErrorActionPreference='Stop'; $m=[Threading.Mutex]::new($false,'Global\\KimiCodeLid-${hash}'); $held=$false; try { try { $held=$m.WaitOne(180000) } catch [Threading.AbandonedMutexException] { $held=$true }; if (!$held) { exit 2 }; [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { if ($held) { $m.ReleaseMutex() }; $m.Dispose() }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let closed = false;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  child.stdin.on('error', () => undefined);
  const finished = new Promise<void>((resolve) => { child.once('close', () => { closed = true; resolve(); }); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Power settings lock timed out')); }, 185_000);
      const finish = (error?: Error): void => { clearTimeout(timer); if (error) reject(error); else resolve(); };
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.includes('ready')) finish(); });
      child.once('error', (error) => finish(error));
      child.once('close', () => finish(new Error(stderr || 'Power settings lock exited')));
    });
    if (closed) throw new Error('Power settings lock exited');
    const result = await operation();
    if (closed) throw new Error('Power settings lock was lost');
    return result;
  } finally {
    child.stdin.end('\n');
    await finished;
  }
}

export function openWindowsLidState(): WindowsLidState {
  return new WindowsLidState(statePath(), ownerId());
}
