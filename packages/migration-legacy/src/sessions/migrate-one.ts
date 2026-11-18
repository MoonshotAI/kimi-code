import { existsSync } from 'node:fs';
import { readFile, mkdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import type { OldSessionState } from '../kimi-cli-schema.js';
import { readTodoItems } from '@moonshot-ai/agent-core-v2/features/todo/todoItem';
import { targetSessionsDir } from '../paths.js';
import { computeWorkdirBucket } from './workdir-bucket.js';
import { closeDanglingToolCalls } from './close-tool-calls.js';
import {
  analyzeContextContent,
  extractLastUsageTokenCount,
  translateContextLines,
  type NormalizedMessage,
} from './translator.js';
import { readMergedSessionState, type LegacySessionRef } from './source.js';
import { writeMainAgentWire } from './wire-writer.js';
import { writeSessionState } from './state-writer.js';
import { extractToolCallDisplays } from './tool-call-display.js';
import { buildSubagentTaskRecords, migrateLegacySubagents } from './subagents.js';

export type MigrateOneResult =
  | { readonly outcome: 'migrated'; readonly targetDir: string }
  | { readonly outcome: 'already-migrated'; readonly targetDir: string }
  | { readonly outcome: 'conflict'; readonly targetDir: string }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'failed'; readonly reason: string };

export interface MigrateOneInput {
  readonly source: LegacySessionRef;
  readonly workdirPath: string;
  readonly targetHome: string;
}

export async function migrateOneSession(input: MigrateOneInput): Promise<MigrateOneResult> {
  const bucket = computeWorkdirBucket(input.workdirPath);
  const targetDir = join(targetSessionsDir(input.targetHome), bucket, `ses_${input.source.uuid}`);

  if (existsSync(targetDir)) {
    const cls = await classifyExistingTarget(targetDir);
    if (cls === 'imported') {
      return { outcome: 'already-migrated', targetDir };
    }
    if (cls === 'foreign') {
      return { outcome: 'conflict', targetDir };
    }
    await rm(targetDir, { recursive: true, force: true });
  }

  const oldState: Partial<OldSessionState> = await readMergedSessionState(input.source.sessionDir);

  let messages: NormalizedMessage[] = [];
  let lastUserPrompt = '';
  let contextLines: readonly string[] = [];
  let oldWireText: string | undefined;
  try {
    if (input.source.contextPath === undefined) {
      return { outcome: 'failed', reason: 'cannot read context.jsonl' };
    }
    const contextText = await readFile(input.source.contextPath, 'utf-8');
    contextLines = contextText.split(/\r?\n/);
    if (input.source.sessionDir !== undefined) {
      try {
        oldWireText = await readFile(join(input.source.sessionDir, 'wire.jsonl'), 'utf-8');
      } catch {}
    }
    const toolCallDisplays =
      oldWireText === undefined ? undefined : extractToolCallDisplays(oldWireText);
    messages = closeDanglingToolCalls(
      translateContextLines(contextLines, toolCallDisplays),
    );
    lastUserPrompt = extractLastUserText(messages);
  } catch {
    return { outcome: 'failed', reason: 'cannot read context.jsonl' };
  }

  const customTitle = oldState.custom_title;
  const hasCustomTitle = typeof customTitle === 'string' && customTitle.length > 0;

  if (messages.length === 0 && !hasCustomTitle) {
    if (analyzeContextContent(contextLines) === 'corrupt') {
      return {
        outcome: 'failed',
        reason: 'context.jsonl is corrupt: no parseable JSON lines',
      };
    }
    return { outcome: 'empty' };
  }

  const wireMtimeS = oldState.wire_mtime ?? null;
  let createdAtMs: number;
  if (wireMtimeS !== null && wireMtimeS !== undefined) {
    createdAtMs = Math.floor(wireMtimeS * 1000);
  } else {
    createdAtMs = await readSourceMtime(input.source) ?? Date.now();
  }

  let wireProtocolFromOld: string | null = null;
  if (oldWireText !== undefined) {
    try {
      const firstLine = oldWireText.split(/\r?\n/)[0];
      if (firstLine !== undefined && firstLine.length > 0) {
        const parsed: unknown = JSON.parse(firstLine);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          typeof (parsed as { protocol_version?: unknown }).protocol_version === 'string'
        ) {
          wireProtocolFromOld = (parsed as { protocol_version: string }).protocol_version;
        }
      }
    } catch {}
  }

  try {
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    const subagents =
      input.source.sessionDir === undefined
        ? []
        : await migrateLegacySubagents(input.source.sessionDir, targetDir);
    await writeMainAgentWire(targetDir, {
      createdAtMs,
      messages,
      lastUsageTokenCount: extractLastUsageTokenCount(contextLines),
      todoItems: readTodoItems(oldState.todos),
      subagentTasks: subagents.map(buildSubagentTaskRecords),
    });
    await writeSessionState(targetDir, {
      oldState,
      sessionId: `ses_${input.source.uuid}`,
      workdirPath: input.workdirPath,
      lastUserPrompt,
      lastTurnReason: messages.some((m) => m.role === 'assistant') ? 'completed' : undefined,
      sourcePath: input.source.sessionDir ?? input.source.contextPath ?? '',
      oldSessionUuid: input.source.uuid,
      wireProtocolFromOld,
      createdAtMs,
      subagentIds: subagents.map((s) => s.agentId),
    });
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    const reason = error instanceof Error ? error.message : String(error);
    return { outcome: 'failed', reason };
  }

  await applyOriginalMtime(targetDir, createdAtMs);

  return { outcome: 'migrated', targetDir };
}

async function readSourceMtime(source: LegacySessionRef): Promise<number | undefined> {
  if (source.sessionDir !== undefined) {
    try {
      return Math.floor((await stat(join(source.sessionDir, 'wire.jsonl'))).mtimeMs);
    } catch {}
  }
  if (source.contextPath !== undefined) {
    try {
      return Math.floor((await stat(source.contextPath)).mtimeMs);
    } catch {}
  }
  return undefined;
}

async function applyOriginalMtime(targetDir: string, createdAtMs: number): Promise<void> {
  const stamp = new Date(createdAtMs);
  try {
    await utimes(join(targetDir, 'agents', 'main', 'wire.jsonl'), stamp, stamp);
    await utimes(join(targetDir, 'state.json'), stamp, stamp);
    await utimes(targetDir, stamp, stamp);
  } catch {}
}

type ExistingTarget = 'imported' | 'foreign' | 'debris';

async function classifyExistingTarget(targetDir: string): Promise<ExistingTarget> {
  let text: string;
  try {
    text = await readFile(join(targetDir, 'state.json'), 'utf-8');
  } catch {
    return 'debris';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'debris';
  }
  if (typeof parsed !== 'object' || parsed === null) return 'debris';
  const custom = (parsed as { custom?: unknown }).custom;
  if (
    typeof custom === 'object' &&
    custom !== null &&
    (custom as { imported_from_kimi_cli?: unknown }).imported_from_kimi_cli === true
  ) {
    return 'imported';
  }
  return 'foreign';
}

function extractLastUserText(messages: readonly NormalizedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role !== 'user') continue;
    const textPart = m.content.find((p) => p.type === 'text');
    if (textPart && textPart.type === 'text') return textPart.text;
  }
  return '';
}
