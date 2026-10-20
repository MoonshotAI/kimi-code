import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { Event } from '#/index';

export interface AgentWirePayload {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface AgentSessionWireRecord {
  readonly type: 'agent';
  readonly agentId: string;
  readonly event: AgentWirePayload;
}

export async function makeTempDir(tempDirs: string[], prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function removeTempDirs(tempDirs: string[]): Promise<void> {
  for (const dir of tempDirs.splice(0)) {
    await removeTempDir(dir);
  }
}

export async function waitForAgentWireEvent(
  homeDir: string,
  sessionId: string,
  eventType: string,
  predicate: (event: AgentWirePayload) => boolean = () => true,
): Promise<AgentWirePayload> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const events = await readWireEvents(homeDir, sessionId);
    for (const event of events) {
      const agentEvent = toMainAgentWirePayload(event);
      if (agentEvent === undefined) continue;
      if (agentEvent.type !== eventType) continue;
      if (predicate(agentEvent)) {
        return agentEvent;
      }
    }
    await delay(10);
  }

  throw new Error(`Timed out waiting for ${eventType} in ${sessionId}`);
}

export function waitForSDKEvent(
  session: {
    onEvent(listener: (event: Event) => void): () => void;
  },
  predicate: (event: Event) => boolean,
  timeoutMs = 1_000,
): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for session event'));
    }, timeoutMs);
    const unsubscribe = session.onEvent((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

async function readWireEvents(homeDir: string, sessionId: string): Promise<readonly unknown[]> {
  const sessionDir = await readIndexedSessionDir(homeDir, sessionId);
  if (sessionDir === undefined) return [];

  try {
    const raw = await readFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw error;
  }
}

function toMainAgentWirePayload(value: unknown): AgentWirePayload | undefined {
  if (isAgentWirePayload(value)) return value;
  if (!isAgentSessionWireRecord(value)) return undefined;
  if (value.agentId !== 'main') return undefined;
  return value.event;
}

async function readIndexedSessionDir(
  homeDir: string,
  sessionId: string,
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(homeDir, 'session_index.jsonl'), 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw error;
  }

  let sessionDir: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (parsed['sessionId'] !== sessionId) continue;
    if (typeof parsed['sessionDir'] !== 'string') continue;
    sessionDir = parsed['sessionDir'];
  }
  return sessionDir;
}

function isAgentSessionWireRecord(value: unknown): value is AgentSessionWireRecord {
  if (!isRecord(value)) return false;
  if (value['type'] !== 'agent') return false;
  if (typeof value['agentId'] !== 'string') return false;
  return isAgentWirePayload(value['event']);
}

function isAgentWirePayload(value: unknown): value is AgentWirePayload {
  return isRecord(value) && typeof value['type'] === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') {
        throw error;
      }
      await delay(10);
    }
  }

  await rm(dir, { recursive: true, force: true });
}
