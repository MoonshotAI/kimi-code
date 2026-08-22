import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Expands a leading tilde (`~` or `~/`) in a file path to the user's home directory.
 */
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

/**
 * Safely attempts to read the `project_id` field from a GCP service account JSON file.
 */
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
    // Ignore unreadable file or invalid JSON; SDK auth will handle invalid files
  }
  return undefined;
}
