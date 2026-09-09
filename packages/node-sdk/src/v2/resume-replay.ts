import { readFile } from 'node:fs/promises';

import {
  foldWireRecords,
  type AgentReplayRecord as V2AgentReplayRecord,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2';

import type { AgentReplayRecord } from '#/replay';

export interface FoldedAgentReplay {
  readonly replay: readonly AgentReplayRecord[];
  readonly toolStore: Readonly<Record<string, unknown>>;
}

const EMPTY_FOLD: FoldedAgentReplay = { replay: [], toolStore: {} };

export async function foldAgentWireReplay(wirePath: string): Promise<FoldedAgentReplay> {
  try {
    const records = parseWireRecords(await readFile(wirePath, 'utf-8'));
    if (records.length === 0) return EMPTY_FOLD;
    const folded = foldWireRecords(records);
    return {
      replay: folded.replay.map(mapReplayRecord),
      toolStore: folded.toolStore,
    };
  } catch {
    return EMPTY_FOLD;
  }
}

function mapReplayRecord(record: V2AgentReplayRecord): AgentReplayRecord {
  if (record.type === 'config_updated') {
    return {
      type: 'config_updated',
      time: record.time,
      config: {
        modelAlias: record.config.modelAlias,
        profileName: record.config.profileName,
        thinkingEffort: record.config.thinkingLevel,
        systemPrompt: record.config.systemPrompt,
      },
    };
  }
  return record as unknown as AgentReplayRecord;
}

function parseWireRecords(content: string): WireRecord[] {
  const lines = content.split('\n');
  const records: WireRecord[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as WireRecord);
    } catch (error) {
      if (index === lines.length - 1) break;
      throw error;
    }
  }
  return records;
}
