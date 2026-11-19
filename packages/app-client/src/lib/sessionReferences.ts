import type { AppSession } from '@moonshot-ai/app-core/api';
import { SESSION_LINK_BASE, parseMentionLinks, parseSessionMentionPath, type SessionMentionRef } from '@moonshot-ai/app-composer/model';
import { configStore } from '../stores/config';

export interface SessionMentionCandidate {
  id: string;
  workspaceId: string;
  title: string;
  lastPrompt?: string;
  workspaceName?: string;
  time: string;
}

export interface SessionMentionCandidatesInput {
  sessions: readonly AppSession[];
  activeSessionId?: string;
  activeWorkspaceId?: string | null;
  workspaceName: (workspaceId: string) => string | undefined;
  formatTime: (iso: string) => string;
}

export function sessionMentionCandidates(input: SessionMentionCandidatesInput): SessionMentionCandidate[] {
  const eligible = input.sessions
    .filter((session): session is AppSession & { workspaceId: string } =>
      session.workspaceId !== undefined && session.deviceId === undefined && !session.archived && session.id !== input.activeSessionId)
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const inActiveWorkspace = eligible.filter((session) => session.workspaceId === input.activeWorkspaceId);
  const elsewhere = eligible.filter((session) => session.workspaceId !== input.activeWorkspaceId);
  return [...inActiveWorkspace, ...elsewhere].map((session) => ({
    id: session.id,
    workspaceId: session.workspaceId,
    title: session.title.trim() || session.lastPrompt?.replace(/\s+/g, ' ').trim() || session.id,
    lastPrompt: session.lastPrompt,
    workspaceName: input.workspaceName(session.workspaceId),
    time: input.formatTime(session.updatedAt),
  }));
}

export interface SessionReference extends SessionMentionRef {
  title: string;
  logPath: string;
}

export function sessionLogPath(home: string, ref: SessionMentionRef): string {
  const root = home.replaceAll('\\', '/').replace(/\/+$/, '');
  return `${root}/sessions/${ref.workspaceId}/${ref.sessionId}/agents/main/wire.jsonl`;
}

function xmlAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function renderSessionReferences(references: readonly SessionReference[]): string {
  const lines = references.map((reference) =>
    `<session id="${xmlAttr(reference.sessionId)}" title="${xmlAttr(reference.title)}" log="${xmlAttr(reference.logPath)}" />`);
  return ['<referenced_sessions>', ...lines, '</referenced_sessions>'].join('\n');
}

function referencedSessionMentions(text: string): Array<SessionMentionRef & { title: string }> {
  const seen = new Set<string>();
  const mentions: Array<SessionMentionRef & { title: string }> = [];
  for (const { attrs } of parseMentionLinks(text)) {
    if (attrs.kind !== 'session' || seen.has(attrs.path)) continue;
    const ref = parseSessionMentionPath(attrs.path);
    if (ref === null) continue;
    seen.add(attrs.path);
    mentions.push({ ...ref, title: attrs.name });
  }
  return mentions;
}

export function withSessionReferences(text: string): string {
  if (!text.includes(SESSION_LINK_BASE)) return text;
  const home = configStore().homeDir;
  if (home === '') return text;
  const mentions = referencedSessionMentions(text);
  if (mentions.length === 0) return text;
  const references = mentions.map((mention) => ({ ...mention, logPath: sessionLogPath(home, mention) }));
  return `${text}\n\n${renderSessionReferences(references)}`;
}
