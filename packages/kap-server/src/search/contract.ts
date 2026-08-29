export interface GlobalSearchQuery {
  readonly query: string;
  readonly mode?: 'terms' | 'literal';
  readonly op?: 'AND' | 'OR';
  readonly container?: {
    readonly sessionId?: string;
    readonly agentId?: string;
  };
  readonly role?: 'user' | 'assistant' | 'title';
  readonly startTime?: number;
  readonly endTime?: number;
  readonly sort?: 'score' | 'time_desc' | 'time_asc';
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export type GlobalSearchErrorReason =
  | 'invalid_query'
  | 'invalid_page_token'
  | 'readonly_index'
  | 'index_unavailable';

export class GlobalSearchError extends Error {
  constructor(
    readonly reason: GlobalSearchErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'GlobalSearchError';
  }
}

export interface GlobalSearchHit {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionTitle: string;
  readonly agentId: string;
  readonly role: 'user' | 'assistant' | 'title';
  readonly snippet: string;
  readonly time: number;
  readonly turn?: number;
  readonly stepId?: string;
  readonly score: number;
}

export interface GlobalSearchIndexState {
  readonly state: 'building' | 'ready' | 'readonly';
  readonly indexedSessions: number;
  readonly totalSessions: number;
  readonly documents: number;
  readonly stale?: boolean;
  readonly degraded?: string;
}

export type GlobalSearchSource = 'live' | 'index';

export type GlobalSearchIncomplete = 'candidate_cap' | 'postings_budget' | 'deadline';

export interface GlobalSearchPage {
  readonly items: GlobalSearchHit[];
  readonly hasMore: boolean;
  readonly pageToken?: string;
  readonly incomplete?: GlobalSearchIncomplete;
  readonly indexState: GlobalSearchIndexState;
  readonly source: GlobalSearchSource;
}
