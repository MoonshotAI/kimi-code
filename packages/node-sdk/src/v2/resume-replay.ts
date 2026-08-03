/**
 * Resume replay fold — rebuilds the v1 `ResumedAgentState.replay` /
 * `toolStore` pair from a v2 agent's `wire.jsonl`.
 *
 * The v2 engine persists each agent's journal at
 * `<sessionDir>/agents/<agentId>/wire.jsonl` using v1's record vocabulary for
 * every replay-relevant op (see `agent-core-v2/src/wire/record.ts` and the op
 * schemas — e.g. `todoOps.ts` states the on-disk vocabulary stays exactly
 * v1's so either engine's reader rebuilds the same state). The v1 engine's
 * own restore pipeline (`Agent` + `AgentRecords.replay`) is therefore the
 * correct fold: it owns the subtle semantics a re-implementation would drift
 * from — assistant-message assembly from loop events (`step.begin` opens an
 * assistant message, `content.part` / `tool.call` mutate it in place,
 * `tool.result` closes the exchange, mid-history gaps are closed with
 * synthesized interrupted results, messages deferred behind an open tool
 * exchange flush in order), `context.undo` removing replayed messages, and
 * `context.apply_compaction` patching the last compaction record with its
 * result.
 *
 * Record-type → replay-record mapping (all produced by the v1 restore; the
 * fold inherits it verbatim):
 * - `context.append_message`      → `{type:'message'}` (same for the
 *   assistant/tool messages assembled out of `context.append_loop_event`)
 * - `full_compaction.begin`       → `{type:'compaction', instruction}`;
 *   `context.apply_compaction` patches the last one with `result`;
 *   `full_compaction.cancel` marks it `'cancelled'`
 * - `goal.create` / `goal.update` → `{type:'goal_updated'}` (`created` /
 *   `lifecycle` / `completion` change)
 * - `plan_mode.enter`             → `{type:'plan_updated', enabled:true}`;
 *   `plan_mode.cancel` / `plan_mode.exit` → `enabled:false`
 * - `config.update`               → `{type:'config_updated', config}` (the raw
 *   record fields, including `type`/`time` — v1's restore quirk)
 * - `permission.set_mode`         → `{type:'permission_updated', mode}`
 * - `permission.record_approval_result` → `{type:'approval_result', record}`
 * - `tools.update_store`          → no replay record; last-wins into the tool
 *   store returned alongside (v1's `agent.tools.storeData()`)
 * - everything else (`metadata`, `turn.*`, `usage.record`,
 *   `tools.set_active_tools`, `context.update_token_count`, loop bookkeeping)
 *   rebuilds state only; v2-only ops (`profile.bind`, `plan.revision`,
 *   `task.started` / `task.terminated`, `skill.activate`, `interaction.*`,
 *   `context_size.measured`, `llm.*`) fall through v1's restore switch
 *   untouched. Two consequences: the v2 profile BINDING never appears as a
 *   `config_updated` replay record (v1 persists the bind as `config.update`,
 *   v2 as `profile.bind` — pinned in the parity KNOWN_DIFFS), and background
 *   tasks do NOT come from this fold (v1 restores them from a side file, v2
 *   from `task.*` ops) — the caller reads them from the live agent scope.
 *
 * The fold runs on a THROWAWAY v1 `Agent` over an in-memory persistence, so
 * it never mutates the journal (a live restore appends synthesized
 * interrupted-tool-result records at `finishResume`; here those appends land
 * in the memory buffer only). Any failure — missing/corrupt file, newer
 * protocol, unexpected record — degrades to an empty result instead of
 * failing the session resume.
 */

import { readFile } from 'node:fs/promises';

import {
  Agent,
  type AgentRecord,
  type AgentRecordPersistence,
  type AgentReplayRecord,
} from '@moonshot-ai/agent-core';
import { LocalKaos } from '@moonshot-ai/kaos';

export interface FoldedAgentReplay {
  readonly replay: readonly AgentReplayRecord[];
  readonly toolStore: Readonly<Record<string, unknown>>;
}

const EMPTY_FOLD: FoldedAgentReplay = { replay: [], toolStore: {} };

/**
 * Read-only `AgentRecordPersistence` over an already-parsed journal. The
 * throwaway fold agent's live writes (the synthesized interrupted-tool-result
 * records `finishResume` appends) land here and go nowhere — the on-disk
 * journal is never mutated. `InMemoryAgentRecordPersistence` would do, but
 * the package root only exports the interface, and node-sdk's vitest aliases
 * `@moonshot-ai/agent-core` to its index, which swallows every deep subpath.
 */
class ReadOnlyAgentRecordPersistence implements AgentRecordPersistence {
  constructor(private readonly records: readonly AgentRecord[]) {}

  async *read(): AsyncIterable<AgentRecord> {
    for (const record of this.records) {
      yield record;
    }
  }

  append(_input: AgentRecord): void {}

  rewrite(_records: readonly AgentRecord[]): void {}

  async flush(): Promise<void> {}

  async close(): Promise<void> {}
}

/**
 * Fold one agent's `wire.jsonl` into the v1 replay records and tool-store
 * snapshot. Best-effort: unreadable or malformed journals yield an empty
 * fold, never a rejected resume.
 */
export async function foldAgentWireReplay(wirePath: string): Promise<FoldedAgentReplay> {
  try {
    const records = parseWireRecords(await readFile(wirePath, 'utf-8'));
    if (records.length === 0) return EMPTY_FOLD;
    const agent = new Agent({
      kaos: await LocalKaos.create(),
      persistence: new ReadOnlyAgentRecordPersistence(records),
      type: 'sub',
    });
    await agent.resume({ rewriteMigratedRecords: false });
    return {
      replay: agent.replayBuilder.buildResult(),
      toolStore: agent.tools.storeData(),
    };
  } catch {
    return EMPTY_FOLD;
  }
}

/**
 * The v1 line reader's rules: blank lines skipped, a truncated TAIL line
 * tolerated (the last write may have crashed mid-flush), corruption anywhere
 * else is an error.
 */
function parseWireRecords(content: string): AgentRecord[] {
  const lines = content.split('\n');
  const records: AgentRecord[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as AgentRecord);
    } catch (error) {
      if (index === lines.length - 1) break;
      throw error;
    }
  }
  return records;
}
