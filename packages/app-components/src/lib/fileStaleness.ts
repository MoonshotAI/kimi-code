
import type { ChatTurn } from '@moonshot-ai/app-core/client/types';
import { toolFilePath } from '@moonshot-ai/app-core/client';
import { normalizeToolName } from '@moonshot-ai/app-core/lib';
import { normalizePathKey, turnBlocks } from '../chatTurnRendering';

const EDIT_KINDS = new Set(['edit', 'multi_edit', 'write']);

export function completedEditToolIds(turn: ChatTurn): string[] {
  const ids: string[] = [];
  for (const block of turnBlocks(turn)) {
    if (block.kind !== 'tool' || block.tool.status !== 'ok') continue;
    if (!EDIT_KINDS.has(normalizeToolName(block.tool.name))) continue;
    ids.push(block.tool.id);
  }
  return ids;
}

export function runningEditToolIds(turn: ChatTurn): string[] {
  const ids: string[] = [];
  for (const block of turnBlocks(turn)) {
    if (block.kind !== 'tool' || block.tool.status !== 'running') continue;
    if (!EDIT_KINDS.has(normalizeToolName(block.tool.name))) continue;
    ids.push(block.tool.id);
  }
  return ids;
}

function toolPathKeys(path: string, cwd?: string): string[] {
  const norm = path.replace(/\\/g, '/');
  const isAbsolute = norm.startsWith('/') || /^[a-zA-Z]:\//.test(norm) || norm.startsWith('//');
  if (isAbsolute || !cwd) return [normalizePathKey(path)];
  return [normalizePathKey(path), normalizePathKey(`${cwd.replace(/\/+$/, '')}/${norm}`)];
}

export function turnFileEditCounts(
  turn: ChatTurn,
  cwd?: string,
  skipToolId?: (toolId: string) => boolean,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of turnBlocks(turn)) {
    if (block.kind !== 'tool' || block.tool.status !== 'ok') continue;
    if (!EDIT_KINDS.has(normalizeToolName(block.tool.name))) continue;
    if (skipToolId?.(block.tool.id)) continue;
    const path = toolFilePath(block.tool);
    if (!path) continue;
    for (const key of toolPathKeys(path, cwd)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

export function editedFileCount(turns: readonly ChatTurn[], cwd?: string): number {
  const paths = new Set<string>();
  let unnamed = 0;
  for (const turn of turns) {
    for (const block of turnBlocks(turn)) {
      if (block.kind !== 'tool' || block.tool.status !== 'ok') continue;
      if (!EDIT_KINDS.has(normalizeToolName(block.tool.name))) continue;
      const path = toolFilePath(block.tool);
      if (path) paths.add(toolPathKeys(path, cwd).at(-1)!);
      else unnamed += 1;
    }
  }
  return paths.size + unnamed;
}

export function editedFileMarkers(
  turns: readonly ChatTurn[],
  cwd?: string,
  isHistoryTool?: (turnId: string, toolId: string) => boolean,
): Map<string, string> {
  const markers = new Map<string, string>();
  for (const turn of turns) {
    const counts = turnFileEditCounts(
      turn,
      cwd,
      isHistoryTool ? (toolId) => isHistoryTool(turn.id, toolId) : undefined,
    );
    for (const [pathKey, count] of counts) {
      markers.set(pathKey, `${turn.id}:${count}`);
    }
  }
  return markers;
}

export function isStaleSince(
  markers: ReadonlyMap<string, string>,
  snapshot: ReadonlyMap<string, string | undefined>,
  keys: readonly string[],
): boolean {
  return keys.some((key) => markers.get(key) !== snapshot.get(key));
}
