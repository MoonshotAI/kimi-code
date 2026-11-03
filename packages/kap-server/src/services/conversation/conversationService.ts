import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  IBootstrapService,
  ISessionIndex,
  MAIN_AGENT_ID,
  flattenChain,
  getLiveSessionById,
  getOrRestoreAgent,
  resumeSessionById,
  sessionDirOf,
  workspacePersistenceScope,
  type IAgentScopeHandle,
  type IDisposable,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  AGENT_WIRE_RECORD_KEY,
  assertWireRecordsReaderVersion,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2/wire/record';

import type { ConversationTurn } from '../../protocol/conversation';
import type { LiveConversationSource } from '../../search/searchService';
import { ensureMainAgent } from '../../transport/mainAgent';
import { applyConversationRecord, createConversationState } from './conversationFold';
import { ConversationFeed } from './conversationFeed';

interface FeedEntry {
  readonly handle: IAgentScopeHandle;
  readonly feed: Promise<ConversationFeed>;
}

interface SessionFeeds {
  readonly session: ISessionScopeHandle;
  readonly feeds: Map<string, FeedEntry>;
  readonly closeWatch: IDisposable;
}

export class ConversationService implements IDisposable, LiveConversationSource {
  private readonly sessions = new Map<string, SessionFeeds>();

  constructor(private readonly core: Scope) {}

  async feed(sessionId: string, agentId: string): Promise<ConversationFeed | undefined> {
    const session = await resumeSessionById(this.core.accessor, sessionId);
    if (session === undefined) return undefined;
    const handle = agentId === MAIN_AGENT_ID
      ? await ensureMainAgent(session)
      : await getOrRestoreAgent(session, agentId);
    if (handle === undefined) return undefined;
    return this.feedFor(sessionId, session, handle);
  }

  liveAgentIds(sessionId: string): readonly string[] | undefined {
    const session = getLiveSessionById(this.core.accessor, sessionId);
    return session?.accessor.get(IAgentLifecycleService).list().map((agent) => agent.agentId);
  }

  async liveTurns(sessionId: string, agentId: string): Promise<readonly ConversationTurn[] | undefined> {
    const session = getLiveSessionById(this.core.accessor, sessionId);
    const handle = session?.accessor.get(IAgentLifecycleService).handleOf(agentId);
    if (session === undefined || handle === undefined) return undefined;
    try {
      return (await this.feedFor(sessionId, session, handle)).turns();
    } catch {
      return undefined;
    }
  }

  async turnsWithoutLoading(
    sessionId: string,
    agentId: string,
  ): Promise<readonly ConversationTurn[] | undefined> {
    const live = await this.liveTurns(sessionId, agentId);
    if (live !== undefined) return live;
    const summary = await this.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    const bootstrap = this.core.accessor.get(IBootstrapService);
    const sessionDir = sessionDirOf(
      bootstrap.homeDir,
      workspacePersistenceScope(bootstrap.scope('sessions'), summary.workspaceId),
      sessionId,
    );
    let text: string;
    try {
      text = await readFile(join(sessionDir, 'agents', agentId, AGENT_WIRE_RECORD_KEY), 'utf-8');
    } catch {
      return [];
    }
    const records = text.split('\n').flatMap((line): WireRecord[] => {
      if (line.trim().length === 0) return [];
      try {
        return [JSON.parse(line) as WireRecord];
      } catch {
        return [];
      }
    });
    assertWireRecordsReaderVersion(records);
    const state = createConversationState();
    for (const record of flattenChain(records)) applyConversationRecord(state, record);
    return state.turns;
  }

  dropSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    this.sessions.delete(sessionId);
    entry.closeWatch.dispose();
    for (const { feed } of entry.feeds.values()) disposeLater(feed);
  }

  dispose(): void {
    for (const sessionId of this.sessions.keys()) this.dropSession(sessionId);
  }

  private feedFor(
    sessionId: string,
    session: ISessionScopeHandle,
    handle: IAgentScopeHandle,
  ): Promise<ConversationFeed> {
    let entry = this.sessions.get(sessionId);
    if (entry !== undefined && entry.session !== session) {
      this.dropSession(sessionId);
      entry = undefined;
    }
    if (entry === undefined) {
      const feeds = new Map<string, FeedEntry>();
      const closeWatch = session.accessor.get(IAgentLifecycleService).onDidClose((agent) => {
        const closed = feeds.get(agent.agentId);
        if (closed === undefined) return;
        feeds.delete(agent.agentId);
        disposeLater(closed.feed);
      });
      entry = { session, feeds, closeWatch };
      this.sessions.set(sessionId, entry);
    }
    const feeds = entry.feeds;
    const existing = feeds.get(handle.id);
    if (existing?.handle === handle) return existing.feed;
    if (existing !== undefined) disposeLater(existing.feed);
    const created: FeedEntry = { handle, feed: ConversationFeed.attach(handle) };
    feeds.set(handle.id, created);
    created.feed.catch(() => {
      if (feeds.get(handle.id) === created) feeds.delete(handle.id);
    });
    return created.feed;
  }
}

function disposeLater(feed: Promise<ConversationFeed>): void {
  void feed.then(
    (resolved) => {
      resolved.dispose();
    },
    () => {},
  );
}
