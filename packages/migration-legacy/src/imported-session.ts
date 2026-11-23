import { existsSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sessionIndexLine } from '@moonshot-ai/agent-core-v2/app/workspace/workspaceAlias';
import { SESSION_META_VERSION } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';

import { targetSessionsDir } from './paths.js';
import { ensureSessionIndexEntry } from './session-index.js';
import { writeMainAgentWire } from './sessions/wire-writer.js';

export interface ImportedSessionMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
}

export interface ImportedSessionInput {
  readonly targetHome: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly workDir: string;
  readonly environmentCwd?: string;
  readonly title: string;
  readonly lastPrompt: string;
  readonly updatedAtMs: number;
  readonly messages: readonly ImportedSessionMessage[];
  readonly custom: Readonly<Record<string, unknown>>;
}

export function importedSessionDir(targetHome: string, projectId: string, sessionId: string): string {
  return join(targetSessionsDir(targetHome), projectId, sessionId);
}

export function isSessionImported(targetHome: string, sessionId: string): boolean {
  const sessionsDir = targetSessionsDir(targetHome);
  if (!existsSync(sessionsDir)) return false;
  return readdirSync(sessionsDir).some((projectId) =>
    existsSync(join(importedSessionDir(targetHome, projectId, sessionId), 'state.json')),
  );
}

export async function writeImportedSession(input: ImportedSessionInput): Promise<string> {
  const sessionDir = importedSessionDir(input.targetHome, input.projectId, input.sessionId);
  await writeMainAgentWire(sessionDir, {
    createdAtMs: input.updatedAtMs,
    messages: input.messages.map((message) => ({ role: message.role, content: message.content, toolCalls: [] })),
  });
  const state = {
    id: input.sessionId,
    version: SESSION_META_VERSION,
    cwd: input.workDir,
    environmentCwd: input.environmentCwd,
    createdAt: input.updatedAtMs,
    updatedAt: input.updatedAtMs,
    archived: false,
    title: input.title,
    titleKind: 'generated',
    isCustomTitle: false,
    lastPrompt: input.lastPrompt.slice(0, 200),
    lastTurnReason: 'completed',
    agents: { main: { homedir: join(sessionDir, 'agents', 'main'), type: 'main', parentAgentId: null } },
    custom: input.custom,
  };
  await writeFile(join(sessionDir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
  await ensureSessionIndexEntry(input.targetHome, sessionIndexLine({ sessionId: input.sessionId, sessionDir, workDir: input.workDir }, input.projectRoot));
  return sessionDir;
}
