import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

export interface TerminalInstance {
  term: Terminal;
  fit: FitAddon;
}

const instances = new Map<string, { instance: TerminalInstance; owner: symbol | null }>();
const moving = new Set<string>();

export function registerTerminalInstance(id: string, instance: TerminalInstance, owner: symbol): void {
  instances.set(id, { instance, owner });
}

export function markTerminalInstanceMoving(id: string): void {
  moving.add(id);
}

export function adoptTerminalInstance(id: string, owner: symbol): TerminalInstance | null {
  if (!moving.delete(id)) return null;
  const entry = instances.get(id);
  if (entry === undefined) return null;
  entry.owner = owner;
  return entry.instance;
}

export function releaseTerminalInstance(id: string, owner: symbol): boolean {
  const entry = instances.get(id);
  if (entry === undefined || entry.owner !== owner) return false;
  if (moving.has(id)) {
    entry.owner = null;
    return false;
  }
  instances.delete(id);
  return true;
}
