import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TodoItem } from '@moonshot-ai/agent-core-v2/features/todo/todoItem';
import type { NormalizedMessage } from './translator.js';
import { buildTurnRecords, splitIntoTurns, type WireRecord } from './turn-structure.js';

export const WIRE_PROTOCOL_VERSION = '1.0';

export interface WireWriteInput {
  readonly createdAtMs: number;
  readonly messages: readonly NormalizedMessage[];
  readonly lastUsageTokenCount?: number;
  readonly todoItems?: readonly TodoItem[];
  readonly subagentTasks?: readonly {
    readonly started: WireRecord;
    readonly terminated: WireRecord;
  }[];
}

export async function writeMainAgentWire(sessionDir: string, input: WireWriteInput): Promise<void> {
  const wireDir = join(sessionDir, 'agents', 'main');
  await mkdir(wireDir, { recursive: true, mode: 0o700 });

  const metadata = {
    type: 'metadata',
    protocol_version: WIRE_PROTOCOL_VERSION,
    created_at: input.createdAtMs,
  };
  const lines: string[] = [JSON.stringify(metadata)];
  // Bare `context.append_message` records alone leave the engine's turn clock
  // at zero on resume: the first live turn would be numbered t0 and collide
  // with the imported history turn the transcript grouping also numbers t0.
  // Interleaving synthesized turn.prompt/turn.ended records advances the clock
  // past the imported turns, so live turns get fresh ids.
  const turns = splitIntoTurns(input.messages);
  const turnRecords = buildTurnRecords(turns, { agentId: 'main', time: input.createdAtMs });
  const withTasks = insertSubagentTaskRecords(turnRecords, input.subagentTasks ?? []);
  for (const record of withTasks) {
    lines.push(JSON.stringify(record));
  }
  if (input.lastUsageTokenCount !== undefined) {
    lines.push(
      JSON.stringify({
        type: 'token_counting.measured',
        agentId: 'main',
        length: input.messages.length,
        tokens: input.lastUsageTokenCount,
        time: input.createdAtMs,
      }),
    );
  }
  // kimi-cli keeps the session todo list in state.json; v2 replays it from a
  // durable tools.update_store wire record, so a migrated session must carry
  // its todos here or the todo panel shows up empty after resume.
  if (input.todoItems !== undefined && input.todoItems.length > 0) {
    lines.push(
      JSON.stringify({
        type: 'tools.update_store',
        agentId: 'main',
        key: 'todo',
        value: input.todoItems,
        time: input.createdAtMs,
      }),
    );
  }
  await writeFile(join(wireDir, 'wire.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

// task.started goes right before the assistant message carrying the Agent
// tool call, task.terminated right after the tool result message — the same
// positions a native run would have written them at. When the tool call is
// not found (protocol too old to carry SubagentEvent links), the pair is
// appended after the turn records instead of being dropped.
export function insertSubagentTaskRecords(
  records: readonly WireRecord[],
  tasks: readonly { readonly started: WireRecord; readonly terminated: WireRecord }[],
): WireRecord[] {
  const out = [...records];
  for (const { started, terminated } of tasks) {
    const parentToolCallId = (started['info'] as { parentToolCallId?: string } | undefined)
      ?.parentToolCallId;
    let callIndex = -1;
    let resultIndex = -1;
    if (parentToolCallId !== undefined && parentToolCallId.length > 0) {
      for (let i = 0; i < out.length; i++) {
        const record = out[i]!;
        if (record.type !== 'context.append_message') continue;
        const message = record['message'] as
          | { role?: string; toolCallId?: string; toolCalls?: readonly { id?: string }[] }
          | undefined;
        if (message === undefined) continue;
        if (
          callIndex === -1 &&
          message.role === 'assistant' &&
          (message.toolCalls ?? []).some((call) => call.id === parentToolCallId)
        ) {
          callIndex = i;
        }
        if (resultIndex === -1 && message.role === 'tool' && message.toolCallId === parentToolCallId) {
          resultIndex = i;
        }
      }
    }
    if (callIndex !== -1 && resultIndex !== -1) {
      out.splice(resultIndex + 1, 0, terminated);
      out.splice(callIndex, 0, started);
    } else if (callIndex !== -1) {
      out.splice(callIndex, 0, started);
      out.push(terminated);
    } else if (resultIndex !== -1) {
      out.splice(resultIndex, 0, started);
      out.splice(resultIndex + 2, 0, terminated);
    } else {
      out.push(started, terminated);
    }
  }
  return out;
}
