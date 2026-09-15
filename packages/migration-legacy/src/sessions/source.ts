import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  OldSessionMetadataSchema,
  OldSessionStateSchema,
  type OldSessionMetadata,
  type OldSessionState,
} from '../kimi-cli-schema.js';

export interface LegacySessionRef {
  readonly uuid: string;
  readonly sessionDir?: string;
  readonly flatContextFile?: string;
  readonly contextPath?: string;
}

export async function listBucketSessions(bucketPath: string): Promise<LegacySessionRef[]> {
  const names = await readdir(bucketPath);
  const byId = new Map<string, { dir?: string; flat?: string }>();
  const remember = (uuid: string): { dir?: string; flat?: string } => {
    const existing = byId.get(uuid);
    if (existing !== undefined) return existing;
    const created: { dir?: string; flat?: string } = {};
    byId.set(uuid, created);
    return created;
  };
  for (const name of names) {
    const fullPath = join(bucketPath, name);
    let st;
    try {
      st = await stat(fullPath);
    } catch {
      remember(name);
      continue;
    }
    if (st.isDirectory()) {
      remember(name).dir = fullPath;
      continue;
    }
    if (st.isFile() && name.endsWith('.jsonl') && name.length > '.jsonl'.length) {
      remember(name.slice(0, -'.jsonl'.length)).flat = fullPath;
    }
  }
  return [...byId.entries()].map(([uuid, found]) => {
    const dirContext =
      found.dir !== undefined && existsSync(join(found.dir, 'context.jsonl'))
        ? join(found.dir, 'context.jsonl')
        : undefined;
    return {
      uuid,
      sessionDir: found.dir,
      flatContextFile: found.flat,
      contextPath: dirContext ?? found.flat,
    };
  });
}

export async function readMergedSessionState(
  sessionDir: string | undefined,
): Promise<Partial<OldSessionState>> {
  if (sessionDir === undefined) return {};
  let state: Partial<OldSessionState> = {};
  try {
    state = OldSessionStateSchema.parse(
      JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf-8')),
    );
  } catch {
    // missing or corrupt state — proceed with defaults
  }
  let metadata: OldSessionMetadata | undefined;
  try {
    metadata = OldSessionMetadataSchema.parse(
      JSON.parse(await readFile(join(sessionDir, 'metadata.json'), 'utf-8')),
    );
  } catch {
    metadata = undefined;
  }
  if (metadata === undefined) return state;
  return mergeLegacyMetadata(state, metadata);
}

export function mergeLegacyMetadata(
  state: Partial<OldSessionState>,
  metadata: OldSessionMetadata,
): Partial<OldSessionState> {
  const merged: Partial<OldSessionState> = { ...state };
  if (
    (merged.custom_title === null || merged.custom_title === undefined) &&
    typeof metadata.title === 'string' &&
    metadata.title !== '' &&
    metadata.title !== 'Untitled'
  ) {
    merged.custom_title = metadata.title;
  }
  if (merged.title_generated !== true && metadata.title_generated === true) {
    merged.title_generated = true;
  }
  if ((merged.title_generate_attempts ?? 0) === 0 && (metadata.title_generate_attempts ?? 0) > 0) {
    merged.title_generate_attempts = metadata.title_generate_attempts;
  }
  if (
    (merged.wire_mtime === null || merged.wire_mtime === undefined) &&
    metadata.wire_mtime !== null &&
    metadata.wire_mtime !== undefined
  ) {
    merged.wire_mtime = metadata.wire_mtime;
  }
  if (merged.archived !== true && metadata.archived === true) {
    merged.archived = true;
  }
  if (
    (merged.archived_at === null || merged.archived_at === undefined) &&
    metadata.archived_at !== null &&
    metadata.archived_at !== undefined
  ) {
    merged.archived_at = metadata.archived_at;
  }
  if (merged.auto_archive_exempt !== true && metadata.auto_archive_exempt === true) {
    merged.auto_archive_exempt = true;
  }
  return merged;
}
