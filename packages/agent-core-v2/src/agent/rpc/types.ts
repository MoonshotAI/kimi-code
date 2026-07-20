/**
 * `rpc` domain (L8) — shared request wrapper types.
 */

export type WithSessionId<T = {}> = T & {
  readonly sessionId: string;
};

export type WithAgentId<T = {}> = T & {
  readonly agentId: string;
};
