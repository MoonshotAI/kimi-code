import type { AppSession } from '@moonshot-ai/app-core/api';
import { mayContainSessionLink, parseMentionLinks } from '@moonshot-ai/app-composer/model';
import { getKimiWebApi } from '../client/deps';
import { configStore } from '../stores/config';
import { sessionsStore } from '../stores/sessions';

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

export function sessionMentionTitle(session: Pick<AppSession, 'id' | 'title' | 'lastPrompt'>): string {
  return session.title.trim() || session.lastPrompt?.replace(/\s+/g, ' ').trim() || session.id;
}

export function sessionMentionCandidates(input: SessionMentionCandidatesInput): SessionMentionCandidate[] {
  const eligible = input.sessions
    .filter((session): session is AppSession & { workspaceId: string } =>
      session.workspaceId !== undefined && session.hostId === undefined && !session.archived && session.id !== input.activeSessionId)
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const inActiveWorkspace = eligible.filter((session) => session.workspaceId === input.activeWorkspaceId);
  const elsewhere = eligible.filter((session) => session.workspaceId !== input.activeWorkspaceId);
  return [...inActiveWorkspace, ...elsewhere].map((session) => ({
    id: session.id,
    workspaceId: session.workspaceId,
    title: sessionMentionTitle(session),
    lastPrompt: session.lastPrompt,
    workspaceName: input.workspaceName(session.workspaceId),
    time: input.formatTime(session.updatedAt),
  }));
}

export interface SessionReference {
  sessionId: string;
  title: string;
  logPath: string;
}

export function sessionLogPath(home: string, workspaceId: string, sessionId: string): string {
  const root = home.replaceAll('\\', '/').replace(/\/+$/, '');
  return `${root}/sessions/${workspaceId}/${sessionId}/agents/main/wire.jsonl`;
}

function xmlAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function renderSessionReferences(references: readonly SessionReference[]): string {
  const lines = references.map((reference) =>
    `<session id="${xmlAttr(reference.sessionId)}" title="${xmlAttr(reference.title)}" log="${xmlAttr(reference.logPath)}" />`);
  return ['<referenced_sessions>', ...lines, '</referenced_sessions>'].join('\n');
}

function referencedSessions(text: string): Array<{ sessionId: string; title: string }> {
  const seen = new Set<string>();
  const mentions: Array<{ sessionId: string; title: string }> = [];
  for (const { attrs } of parseMentionLinks(text)) {
    if (attrs.kind !== 'session' || seen.has(attrs.path)) continue;
    seen.add(attrs.path);
    mentions.push({ sessionId: attrs.path, title: attrs.name });
  }
  return mentions;
}

const fetchedWorkspaceBySession = new Map<string, string | null>();

function localWorkspaceId(session: Pick<AppSession, 'workspaceId' | 'hostId'>): string | null {
  return session.hostId === undefined ? session.workspaceId ?? null : null;
}

function loadedSession(sessionId: string): AppSession | undefined {
  return sessionsStore().sessions.find((session) => session.id === sessionId);
}

function referencedWorkspaceId(sessionId: string): string | null | undefined {
  const loaded = loadedSession(sessionId);
  return loaded === undefined ? fetchedWorkspaceBySession.get(sessionId) : localWorkspaceId(loaded);
}

export function hasUnresolvedSessionReferences(text: string): boolean {
  return mayContainSessionLink(text) && referencedSessions(text).some(({ sessionId }) => loadedSession(sessionId) === undefined);
}

export async function resolveSessionReferences(text: string): Promise<void> {
  const unloaded = referencedSessions(text).filter(({ sessionId }) => loadedSession(sessionId) === undefined);
  await Promise.all(unloaded.map(async ({ sessionId }) => {
    try {
      fetchedWorkspaceBySession.set(sessionId, localWorkspaceId(await getKimiWebApi().getSession(sessionId, { background: true })));
    } catch {
      fetchedWorkspaceBySession.delete(sessionId);
    }
  }));
}

export function withSessionReferences(text: string): string {
  if (!mayContainSessionLink(text)) return text;
  const home = configStore().homeDir;
  if (home === '') return text;
  const references = referencedSessions(text).flatMap(({ sessionId, title }) => {
    const workspaceId = referencedWorkspaceId(sessionId);
    return typeof workspaceId === 'string' ? [{ sessionId, title, logPath: sessionLogPath(home, workspaceId, sessionId) }] : [];
  });
  if (references.length === 0) return text;
  return `${text}\n\n${renderSessionReferences(references)}`;
}
