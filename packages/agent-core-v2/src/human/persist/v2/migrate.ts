import { readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { messageAppended, stateUpdated, turnEnded } from '#/agent/events';
import { agentOpened, SESSION_LOG_BRANCH, sessionMetaUpdated } from '#/session/events';
import { NodeBackend } from '#/store/backend/node';
import { TreeStore } from '#/store/store';
import type { Branch } from '#/store/branch';

import { convertV2Message, type V2BlobResolver } from './convert';
import { foldV2WireRecords } from './fold';
import { readV2WireRecords, type V2WireRecord } from './wire';

export const V2_SESSION_TREE_NAME = 'session';

export class V2MigrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'V2MigrationError';
    this.code = code;
  }
}

export interface V2MigrationResult {
  treeName: string;
  agents: string[];
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function listV2AgentIds(dir: string): Promise<string[]> {
  const agentsDir = join(dir, 'agents');
  let names: string[];
  try {
    names = await readdir(agentsDir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names.toSorted()) {
    if (await pathIsFile(join(agentsDir, name, 'wire.jsonl'))) ids.push(name);
  }
  return ids;
}

export async function isV2SessionDir(dir: string): Promise<boolean> {
  if (await pathIsDirectory(join(dir, 'trees'))) return false;
  if (!(await pathIsFile(join(dir, 'state.json')))) return false;
  return (await listV2AgentIds(dir)).length > 0;
}

function toEpochMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function normalizeTitle(raw: Record<string, unknown>): { title?: string; titleKind?: string } {
  const title = typeof raw['title'] === 'string' ? raw['title'] : undefined;
  if (title !== undefined && raw['isCustomTitle'] === true) return { title, titleKind: 'custom' };
  if (
    title !== undefined &&
    (raw['titleKind'] === 'replaceable' ||
      raw['titleKind'] === 'generated' ||
      raw['titleKind'] === 'custom')
  ) {
    return { title, titleKind: raw['titleKind'] };
  }
  if (title !== undefined && raw['isCustomTitle'] === false) return { title, titleKind: 'replaceable' };
  if (typeof raw['customTitle'] === 'string') return { title: raw['customTitle'], titleKind: 'custom' };
  return title === undefined ? {} : { title, titleKind: 'replaceable' };
}

function normalizeV2SessionMeta(
  raw: Record<string, unknown>,
  fallbackId: string,
): Record<string, unknown> {
  const {
    workDir,
    titleSource: _titleSource,
    isCustomTitle: _isCustomTitle,
    customTitle: _customTitle,
    createdAt,
    updatedAt,
    ...rest
  } = raw;
  const cwd =
    typeof rest['cwd'] === 'string'
      ? rest['cwd']
      : typeof workDir === 'string' && workDir.length > 0
        ? workDir
        : undefined;
  const { title, titleKind } = normalizeTitle(raw);
  return {
    ...rest,
    id: typeof rest['id'] === 'string' ? rest['id'] : fallbackId,
    version: 2,
    cwd,
    title,
    titleKind,
    createdAt: toEpochMs(createdAt),
    updatedAt: toEpochMs(updatedAt),
    archived: rest['archived'] === true,
  };
}

export async function migrateV2Session(dir: string): Promise<V2MigrationResult> {
  if (!(await isV2SessionDir(dir))) {
    throw new V2MigrationError('not-v2-session', `${dir} is not a v2 session directory`);
  }
  const statePath = join(dir, 'state.json');
  let rawMeta: unknown;
  try {
    rawMeta = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    throw new V2MigrationError(
      'invalid-state-json',
      `cannot read or parse ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof rawMeta !== 'object' || rawMeta === null || Array.isArray(rawMeta)) {
    throw new V2MigrationError('invalid-state-json', `${statePath} does not contain an object`);
  }
  const meta = normalizeV2SessionMeta(rawMeta as Record<string, unknown>, basename(dir));
  const agentIds = await listV2AgentIds(dir);
  const tmp = join(
    dir,
    `.migrate-${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const branches: Branch[] = [];
  try {
    const store = await TreeStore.open(new NodeBackend(tmp));
    const tree = await store.tree(V2_SESSION_TREE_NAME);
    const log = tree.createBranch(SESSION_LOG_BRANCH);
    branches.push(log);
    for (const agentId of agentIds) {
      const agentDir = join(dir, 'agents', agentId);
      const records: V2WireRecord[] = [];
      for await (const record of readV2WireRecords(join(agentDir, 'wire.jsonl'), { agentId })) {
        records.push(record);
      }
      const folded = foldV2WireRecords(records);
      const branch = tree.createBranch(agentId);
      branches.push(branch);
      const resolveBlob: V2BlobResolver = async (hash) => {
        try {
          return (await readFile(join(agentDir, 'blobs', hash))).toString('base64');
        } catch {
          return null;
        }
      };
      for (const message of folded.messages) {
        const converted = await convertV2Message(
          message,
          folded.assistantExtras.get(message),
          resolveBlob,
        );
        if (converted === null) continue;
        await branch.append({
          type: messageAppended.type,
          kind: 'event',
          data: messageAppended({ message: converted }),
        });
      }
      const lastTurnId = folded.nextTurnId - 1;
      if (folded.todos.length > 0) {
        await branch.append({
          type: stateUpdated.type,
          kind: 'event',
          data: stateUpdated({
            name: 'todo',
            value: { todos: folded.todos, lastWriteTurn: Math.max(0, lastTurnId) },
          }),
        });
      }
      if (folded.nextTurnId > 0) {
        await branch.append({
          type: turnEnded.type,
          kind: 'event',
          data: turnEnded({ turnId: lastTurnId, outcome: 'done' }),
        });
      }
      await log.append({
        type: agentOpened.type,
        kind: 'event',
        data: agentOpened({ agentId, branch: agentId }),
      });
    }
    await log.append({ type: sessionMetaUpdated.type, kind: 'event', data: sessionMetaUpdated({ meta }) });
    for (const branchName of tree.branches()) {
      await tree.openBranch(branchName).settled();
    }
    if (await pathIsDirectory(join(tmp, 'blobs'))) {
      await rename(join(tmp, 'blobs'), join(dir, 'blobs'));
    }
    await rename(join(tmp, 'trees'), join(dir, 'trees'));
  } finally {
    await Promise.allSettled(branches.map((branch) => branch.settled()));
    await rm(tmp, { recursive: true, force: true });
  }
  return { treeName: V2_SESSION_TREE_NAME, agents: agentIds };
}
