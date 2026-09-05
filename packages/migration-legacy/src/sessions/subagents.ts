import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { readTodoItems } from '@moonshot-ai/agent-core-v2/features/todo/todoItem';

import { closeDanglingToolCalls } from './close-tool-calls.js';
import { extractToolCallDisplays } from './tool-call-display.js';
import {
  extractLastUsageTokenCount,
  translateContextLines,
  type NormalizedMessage,
} from './translator.js';
import { buildTurnRecords, splitIntoTurns, type WireRecord } from './turn-structure.js';

export interface LegacySubagentInfo {
  readonly agentId: string;
  readonly subagentType: string;
  readonly description: string;
  readonly status: 'completed' | 'failed' | 'lost';
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly model?: string;
  readonly parentToolCallId?: string;
}

const TERMINAL_SUBAGENT_STATUSES = new Set(['idle', 'completed', 'done']);
const FAILED_SUBAGENT_STATUSES = new Set(['error', 'failed']);

interface SubagentEventLink {
  readonly parentToolCallId?: string;
  readonly firstPrompt?: string;
}

/**
 * Migrate every legacy `subagents/<agent_id>/` under a source session dir into
 * v2 per-agent wires at `<targetDir>/agents/<agentId>/wire.jsonl`, and return
 * the info needed to register them in meta.agents and to synthesize matching
 * task records in the main agent's wire. The legacy agent ids are kept as-is —
 * they are the keys the main agent's records (SubagentEvent payloads, tool
 * results) reference. A subagent whose wire already exists in the target is
 * reported but not rewritten, so re-runs stay idempotent.
 */
export async function migrateLegacySubagents(
  sourceSessionDir: string,
  targetDir: string,
): Promise<readonly LegacySubagentInfo[]> {
  const subagentsRoot = join(sourceSessionDir, 'subagents');
  let entries: string[];
  try {
    entries = await readdir(subagentsRoot);
  } catch {
    return [];
  }
  const links = await extractSubagentEventLinks(sourceSessionDir);
  const out: LegacySubagentInfo[] = [];
  for (const entry of entries) {
    const info = await migrateOneSubagent(join(subagentsRoot, entry), links.get(entry), targetDir);
    if (info !== undefined) out.push(info);
  }
  return out;
}

async function migrateOneSubagent(
  dir: string,
  link: SubagentEventLink | undefined,
  targetDir: string,
): Promise<LegacySubagentInfo | undefined> {
  const meta = await readSubagentMeta(dir);
  if (meta === undefined) return undefined;

  const wirePath = join(targetDir, 'agents', meta.agentId, 'wire.jsonl');
  if (existsSync(wirePath)) {
    return {
      agentId: meta.agentId,
      subagentType: meta.subagentType,
      description: meta.description ?? link?.firstPrompt ?? '',
      status: mapSubagentStatus(meta.status),
      startedAtMs: meta.createdAtMs ?? Date.now(),
      endedAtMs: meta.updatedAtMs ?? meta.createdAtMs ?? Date.now(),
      model: meta.model,
      parentToolCallId: link?.parentToolCallId,
    };
  }

  let messages: NormalizedMessage[] = [];
  try {
    const contextText = await readFile(join(dir, 'context.jsonl'), 'utf-8');
    const contextLines = contextText.split(/\r?\n/);
    let displays;
    try {
      displays = extractToolCallDisplays(await readFile(join(dir, 'wire.jsonl'), 'utf-8'));
    } catch {
      displays = undefined;
    }
    messages = closeDanglingToolCalls(translateContextLines(contextLines, displays));
    if (messages.length === 0) return undefined;
    const createdAtMs = meta.createdAtMs ?? Date.now();
    await writeSubagentWire(targetDir, meta.agentId, {
      createdAtMs,
      messages,
      lastUsageTokenCount: extractLastUsageTokenCount(contextLines),
      todoItems: await readSubagentTodos(dir),
    });
  } catch {
    return undefined;
  }

  return {
    agentId: meta.agentId,
    subagentType: meta.subagentType,
    description: meta.description ?? link?.firstPrompt ?? '',
    status: mapSubagentStatus(meta.status),
    startedAtMs: meta.createdAtMs ?? Date.now(),
    endedAtMs: meta.updatedAtMs ?? meta.createdAtMs ?? Date.now(),
    model: meta.model,
    parentToolCallId: link?.parentToolCallId,
  };
}

interface SubagentMeta {
  readonly agentId: string;
  readonly subagentType: string;
  readonly status: string;
  readonly description?: string;
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
  readonly model?: string;
}

async function readSubagentMeta(dir: string): Promise<SubagentMeta | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf-8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const agentId = record['agent_id'];
  if (typeof agentId !== 'string' || agentId.length === 0) return undefined;
  const launchSpec = record['launch_spec'];
  const model =
    typeof launchSpec === 'object' && launchSpec !== null
      ? ((launchSpec as Record<string, unknown>)['effective_model'] ??
        (launchSpec as Record<string, unknown>)['model_override'])
      : undefined;
  return {
    agentId,
    subagentType: typeof record['subagent_type'] === 'string' ? record['subagent_type'] : 'agent',
    status: typeof record['status'] === 'string' ? record['status'] : 'idle',
    description: typeof record['description'] === 'string' ? record['description'] : undefined,
    createdAtMs: toMs(record['created_at']),
    updatedAtMs: toMs(record['updated_at']),
    model: typeof model === 'string' ? model : undefined,
  };
}

function toMs(seconds: unknown): number | undefined {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? Math.floor(seconds * 1000)
    : undefined;
}

async function readSubagentTodos(dir: string): Promise<ReturnType<typeof readTodoItems>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return [];
    return readTodoItems((parsed as Record<string, unknown>)['todos']);
  } catch {
    return [];
  }
}

function mapSubagentStatus(status: string): 'completed' | 'failed' | 'lost' {
  if (TERMINAL_SUBAGENT_STATUSES.has(status)) return 'completed';
  if (FAILED_SUBAGENT_STATUSES.has(status)) return 'failed';
  return 'lost';
}

// The main wire's SubagentEvent records are the only place that links a
// subagent run to the Agent tool call that spawned it (parent_tool_call_id)
// and carries its launch prompt (first TurnBegin user_input).
async function extractSubagentEventLinks(
  sourceSessionDir: string,
): Promise<ReadonlyMap<string, SubagentEventLink>> {
  const links = new Map<string, { parentToolCallId?: string; firstPrompt?: string }>();
  let text: string;
  try {
    text = await readFile(join(sourceSessionDir, 'wire.jsonl'), 'utf-8');
  } catch {
    return links;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const message = (parsed as Record<string, unknown>)['message'];
    if (typeof message !== 'object' || message === null) continue;
    const m = message as Record<string, unknown>;
    if (m['type'] !== 'SubagentEvent') continue;
    const payload = m['payload'];
    if (typeof payload !== 'object' || payload === null) continue;
    const p = payload as Record<string, unknown>;
    const agentId = p['agent_id'];
    if (typeof agentId !== 'string' || agentId.length === 0) continue;
    const link = links.get(agentId) ?? {};
    if (link.parentToolCallId === undefined && typeof p['parent_tool_call_id'] === 'string') {
      link.parentToolCallId = p['parent_tool_call_id'];
    }
    const event = p['event'];
    if (
      link.firstPrompt === undefined &&
      typeof event === 'object' &&
      event !== null &&
      (event as Record<string, unknown>)['type'] === 'TurnBegin'
    ) {
      const eventPayload = (event as Record<string, unknown>)['payload'];
      const input =
        typeof eventPayload === 'object' && eventPayload !== null
          ? (eventPayload as Record<string, unknown>)['user_input']
          : undefined;
      if (typeof input === 'string' && input.length > 0) link.firstPrompt = input;
    }
    links.set(agentId, link);
  }
  return links;
}

interface SubagentWireInput {
  readonly createdAtMs: number;
  readonly messages: readonly NormalizedMessage[];
  readonly lastUsageTokenCount?: number;
  readonly todoItems: ReturnType<typeof readTodoItems>;
}

async function writeSubagentWire(
  targetDir: string,
  agentId: string,
  input: SubagentWireInput,
): Promise<void> {
  const wireDir = join(targetDir, 'agents', agentId);
  await mkdir(wireDir, { recursive: true, mode: 0o700 });
  const metadata = {
    type: 'metadata',
    protocol_version: '1.0',
    created_at: input.createdAtMs,
  };
  const lines: string[] = [JSON.stringify(metadata)];
  for (const record of buildTurnRecords(splitIntoTurns(input.messages), {
    agentId,
    time: input.createdAtMs,
  })) {
    lines.push(JSON.stringify(record));
  }
  if (input.lastUsageTokenCount !== undefined) {
    lines.push(
      JSON.stringify({
        type: 'token_counting.measured',
        agentId,
        length: input.messages.length,
        tokens: input.lastUsageTokenCount,
        time: input.createdAtMs,
      }),
    );
  }
  if (input.todoItems.length > 0) {
    lines.push(
      JSON.stringify({
        type: 'tools.update_store',
        agentId,
        key: 'todo',
        value: input.todoItems,
        time: input.createdAtMs,
      }),
    );
  }
  await writeFile(join(wireDir, 'wire.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

/**
 * The task.started/task.terminated records that make a migrated subagent show
 * up in the main agent's task list, exactly as a native run would leave them.
 */
export function buildSubagentTaskRecords(
  info: LegacySubagentInfo,
): { readonly started: WireRecord; readonly terminated: WireRecord } {
  const base = {
    kind: 'agent',
    taskId: info.agentId,
    description: info.description,
    agentId: info.agentId,
    subagentType: info.subagentType,
    parentToolCallId: info.parentToolCallId,
    model: info.model,
  };
  return {
    started: {
      type: 'task.started',
      agentId: 'main',
      info: { ...base, status: 'running', startedAt: info.startedAtMs, endedAt: null },
      time: info.startedAtMs,
    },
    terminated: {
      type: 'task.terminated',
      agentId: 'main',
      info: { ...base, status: info.status, startedAt: info.startedAtMs, endedAt: info.endedAtMs },
      time: info.endedAtMs,
    },
  };
}
