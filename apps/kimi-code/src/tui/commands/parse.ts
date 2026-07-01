import type { ParsedSlashInput } from './types';

export function parseSlashInput(input: string): ParsedSlashInput | null {
  if (!input.startsWith('/')) return null;
  const trimmed = input.slice(1).trim();
  if (trimmed.length === 0) return null;
  const spaceIdx = trimmed.indexOf(' ');
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  // Reject file paths (e.g. `/usr/local/bin`), but allow namespaced plugin
  // commands whose name itself contains `/` (e.g. `plugin:frontend/component`).
  if (name.includes('/') && !name.includes(':')) return null;
  return { name, args };
}
