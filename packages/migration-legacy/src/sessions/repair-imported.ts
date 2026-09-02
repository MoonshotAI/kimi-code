import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readTodoItems, type TodoItem } from '@moonshot-ai/agent-core-v2/features/todo/todoItem';

import { targetSessionsDir } from '../paths.js';
import { readMergedSessionState } from './source.js';
import { buildSubagentTaskRecords, migrateLegacySubagents } from './subagents.js';
import {
  IMPORT_FORMAT_VERSION,
  buildTurnRecords,
  splitIntoTurns,
  type TurnMessage,
  type WireRecord,
} from './turn-structure.js';
import { insertSubagentTaskRecords } from './wire-writer.js';

/**
 * In-place repair for sessions imported by an earlier migrator that lacks data
 * the current migrator writes (turn-structure records, imported todo list).
 * Only the imported prefix is rewritten; live records the user appended after
 * the import are preserved verbatim.
 *
 * Returns `true` when anything changed. Returns `false` when there is nothing
 * to repair (already current, or the target is unreadable/corrupt), and
 * leaves every file untouched.
 */
export async function repairImportedSessionWire(targetDir: string): Promise<boolean> {
  const statePath = join(targetDir, 'state.json');
  let meta: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath, 'utf-8'));
    if (typeof parsed === 'object' && parsed !== null) meta = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  if (meta === undefined) return false;

  const wirePath = join(targetDir, 'agents', 'main', 'wire.jsonl');
  let text: string;
  try {
    text = await readFile(wirePath, 'utf-8');
  } catch {
    return false;
  }
  const records = parseWireRecords(text);
  if (records === undefined) return false;

  let index = 0;
  let metadata: WireRecord | undefined;
  if (records[0]?.type === 'metadata') {
    metadata = records[0];
    index = 1;
  }
  const createdAt = metadata?.['created_at'];
  const time = typeof createdAt === 'number' ? createdAt : Date.now();

  const hasTurnStructure = records
    .slice(index, firstIndexOfType(records, index, 'context.append_message'))
    .some((record) => record.type === 'turn.prompt');

  let prefix: WireRecord[];
  if (hasTurnStructure) {
    // Consume the imported turn groups so the boundary to live history is found.
    const end = consumeImportedTurnGroups(records, index);
    prefix = records.slice(index, end);
    index = end;
  } else {
    // The imported prefix is the leading run of context.append_message records
    // written by the old migrator; rebuild it with turn structure inserted.
    const importedMessages: TurnMessage[] = [];
    while (index < records.length && records[index]!.type === 'context.append_message') {
      const message = records[index]!['message'];
      if (typeof message !== 'object' || message === null) return false;
      importedMessages.push(message as TurnMessage);
      index += 1;
    }
    if (importedMessages.length === 0) return false;
    prefix = buildTurnRecords(splitIntoTurns(importedMessages), { agentId: 'main', time });
  }
  const liveSuffix = records.slice(index);

  let changed = !hasTurnStructure;

  const hasTodoRecord = records.some(
    (record) => record.type === 'tools.update_store' && record['key'] === 'todo',
  );
  const todoItems = hasTodoRecord ? [] : await readSourceTodos(meta);
  if (todoItems.length > 0) {
    prefix = [
      ...prefix,
      { type: 'tools.update_store', agentId: 'main', key: 'todo', value: todoItems, time },
    ];
    changed = true;
  }

  let metaChanged = false;
  const sourceDir = readSourceDir(meta);
  if (sourceDir !== undefined) {
    const subagents = await migrateLegacySubagents(sourceDir, targetDir);
    const missingTasks = subagents.filter(
      (info) =>
        !records.some(
          (record) =>
            record.type === 'task.started' &&
            (record['info'] as { agentId?: string } | undefined)?.agentId === info.agentId,
        ),
    );
    if (missingTasks.length > 0) {
      prefix = insertSubagentTaskRecords(prefix, missingTasks.map(buildSubagentTaskRecords));
      changed = true;
    }
    if (ensureSubagentRegistrations(meta, subagents, targetDir)) metaChanged = true;
  }

  if (ensureMetaFields(meta, records, prefix)) metaChanged = true;
  if (!changed && !metaChanged) return false;

  if (changed) {
    const rebuilt: WireRecord[] = [
      ...(metadata === undefined ? [] : [metadata]),
      ...prefix,
      ...liveSuffix,
    ];
    await writeFile(
      wirePath,
      rebuilt.map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf-8',
    );
  }
  if (metaChanged) {
    await writeFile(statePath, JSON.stringify(meta, null, 2), 'utf-8');
  }
  return true;
}

function parseWireRecords(text: string): WireRecord[] | undefined {
  const records: WireRecord[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A corrupt line means we cannot safely re-emit the file — leave it alone.
      return undefined;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { type?: unknown }).type !== 'string'
    ) {
      return undefined;
    }
    records.push(parsed as WireRecord);
  }
  return records;
}

function firstIndexOfType(
  records: readonly WireRecord[],
  from: number,
  type: string,
): number {
  const found = records.findIndex((record, i) => i >= from && record.type === type);
  return found === -1 ? records.length : found;
}

function consumeImportedTurnGroups(records: readonly WireRecord[], from: number): number {
  let index = from;
  while (index < records.length && records[index]!.type === 'turn.prompt') {
    index += 1;
    while (index < records.length && records[index]!.type === 'context.append_message') {
      index += 1;
    }
    if (index < records.length && records[index]!.type === 'turn.ended') index += 1;
  }
  return index;
}

async function readSourceTodos(meta: Record<string, unknown>): Promise<readonly TodoItem[]> {
  const sourceDir = readSourceDir(meta);
  if (sourceDir === undefined) return [];
  const oldState = await readMergedSessionState(sourceDir);
  return readTodoItems(oldState.todos);
}

function readSourceDir(meta: Record<string, unknown>): string | undefined {
  const custom = meta['custom'];
  if (typeof custom !== 'object' || custom === null) return undefined;
  const sourcePath = (custom as Record<string, unknown>)['kimi_cli_source_path'];
  return typeof sourcePath === 'string' && sourcePath.length > 0 ? sourcePath : undefined;
}

// Register migrated subagents in meta.agents so the session roster exposes
// their transcripts. Existing entries are never overwritten.
function ensureSubagentRegistrations(
  meta: Record<string, unknown>,
  subagents: readonly { readonly agentId: string }[],
  targetDir: string,
): boolean {
  if (subagents.length === 0) return false;
  const agents =
    typeof meta['agents'] === 'object' && meta['agents'] !== null
      ? (meta['agents'] as Record<string, unknown>)
      : undefined;
  const nextAgents: Record<string, unknown> = { ...agents };
  let changed = false;
  for (const info of subagents) {
    if (nextAgents[info.agentId] !== undefined) continue;
    nextAgents[info.agentId] = {
      homedir: join(targetDir, 'agents', info.agentId),
      type: 'sub',
      parentAgentId: 'main',
      labels: { parentAgentId: 'main' },
    };
    changed = true;
  }
  if (changed) meta['agents'] = nextAgents;
  return changed;
}

// Stamp the current import format version and backfill lastTurnReason (the
// session-outcome mirror clears a persisted reason when the wire has no ended
// turn). Returns whether meta was modified.
function ensureMetaFields(
  meta: Record<string, unknown>,
  records: readonly WireRecord[],
  prefix: readonly WireRecord[],
): boolean {
  let changed = false;
  const custom = meta['custom'];
  if (typeof custom === 'object' && custom !== null) {
    const record = custom as Record<string, unknown>;
    if (record['import_format_version'] !== IMPORT_FORMAT_VERSION) {
      record['import_format_version'] = IMPORT_FORMAT_VERSION;
      changed = true;
    }
  }
  if (
    meta['lastTurnReason'] === undefined &&
    [...records, ...prefix].some((record) => record.type === 'turn.ended')
  ) {
    meta['lastTurnReason'] = 'completed';
    changed = true;
  }
  return changed;
}

/**
 * Count previously imported sessions under the target home whose import format
 * predates the current migrator (see IMPORT_FORMAT_VERSION). Drives
 * repair-aware detection: a completed migration marker must not permanently
 * hide sessions an old migrator left unrepaired. One small state.json read
 * per session, cheap enough to run on every startup.
 */
export async function countImportedSessionsNeedingRepair(targetHome: string): Promise<number> {
  const sessionsRoot = targetSessionsDir(targetHome);
  let bucketNames: string[];
  try {
    bucketNames = await readdir(sessionsRoot);
  } catch {
    return 0;
  }
  let count = 0;
  for (const bucketName of bucketNames) {
    let sessionNames: string[];
    try {
      sessionNames = await readdir(join(sessionsRoot, bucketName));
    } catch {
      continue;
    }
    for (const sessionName of sessionNames) {
      if (await importedSessionNeedsRepair(join(sessionsRoot, bucketName, sessionName))) {
        count++;
      }
    }
  }
  return count;
}

async function importedSessionNeedsRepair(sessionDir: string): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf-8'));
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const custom = (parsed as { custom?: unknown }).custom;
  if (typeof custom !== 'object' || custom === null) return false;
  const record = custom as Record<string, unknown>;
  if (record['imported_from_kimi_cli'] !== true) return false;
  const version = record['import_format_version'];
  return typeof version !== 'number' || version < IMPORT_FORMAT_VERSION;
}
