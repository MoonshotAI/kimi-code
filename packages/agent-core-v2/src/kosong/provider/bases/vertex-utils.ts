import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function expandHomePath(filePath: string | undefined): string | undefined {
  if (filePath === undefined) return undefined;
  const trimmed = filePath.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function tryReadProjectIdFromServiceAccount(filePath: string | undefined): string | undefined {
  if (filePath === undefined) return undefined;
  const expanded = expandHomePath(filePath);
  if (expanded === undefined) return undefined;
  try {
    const content = readFileSync(expanded, 'utf8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed['project_id'] === 'string' && parsed['project_id'].length > 0) {
      return parsed['project_id'];
    }
  } catch {
    return undefined;
  }
  return undefined;
}
