import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'pathe';
import { setTimeout as delay } from 'node:timers/promises';

import type { Event } from '#/index';

/**
 * Minimal LlmChatResponse-shaped object a fake `llmStep` must return (the
 * engine host-proxy model step; see `@moonshot-ai/kimi-agent/rust-loop`
 * LlmChatResponse). Tests that drive real engine turns supply a `llmStep`
 * built with `fakeLlmStep()` — the retired JS-engine kosong `createProvider`
 * mock does not reach the Rust engine.
 */
export interface FakeLlmStepOptions {
  readonly responseText?: string;
  /** Shared call log the test can inspect for per-turn model requests. */
  readonly calls?: unknown[];
}

export function fakeLlmStep(
  state: FakeLlmStepOptions = {},
): (req: unknown) => Promise<unknown> {
  return async (req) => {
    state.calls?.push(req);
    return {
      content: state.responseText ?? 'hello from fake llm',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    };
  };
}

/** An llmStep that never settles — keeps a turn active until cancelled. */
export const HANGING_LLM_STEP: (req: unknown) => Promise<unknown> = () => new Promise(() => {});

/** Write a config.toml with a fake provider/model so the SDK can start
 *  sessions against the Rust engine (which resolves the model host-side). */
export async function writeFakeModelConfig(homeDir: string): Promise<void> {
  await writeFile(
    join(homeDir, 'config.toml'),
    `
default_model = "fake-model"

[providers.local]
type = "kimi"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models.fake-model]
provider = "local"
model = "fake-model"
max_context_size = 1000
`,
    'utf-8',
  );
}

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
  // mkdtemp returns the OS-native path; normalize it to forward slashes so it
  // matches the pathe-style paths the SDK returns on every host.
  const dir = normalize(await mkdtemp(join(tmpdir(), prefix)));
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
