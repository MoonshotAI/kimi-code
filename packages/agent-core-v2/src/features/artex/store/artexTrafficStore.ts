export const ARTEX_TRAFFIC_ROLES = ['baseline', 'proof', 'verification', 'supporting'] as const;
export type ArtexTrafficRole = (typeof ARTEX_TRAFFIC_ROLES)[number];

export function isArtexTrafficRole(role: string): role is ArtexTrafficRole {
  return (ARTEX_TRAFFIC_ROLES as readonly string[]).includes(role);
}

/** One captured request/response pair, as recorded by the proxy. */
export interface ArtexExchangeInput {
  readonly host: string;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly reqHead: string;
  readonly respHead: string;
  readonly reqBody: Buffer;
  readonly respBody: Buffer;
}

/** The ultra-light index row returned by search (never carries bodies). */
export interface ArtexExchangeMeta {
  readonly id: string;
  readonly ts: number;
  readonly host: string;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly respLen: number;
}

export interface ArtexExchangeRaw {
  readonly request: string;
  readonly response: string;
}

export interface ArtexTrafficSearchQuery {
  readonly host: string;
  readonly contains?: string;
  readonly bodyContains?: string;
  readonly page?: number;
  readonly limit?: number;
}

/** A reference handed in by a tool to bind a captured exchange to a finding. */
export interface ArtexTrafficRef {
  readonly trafficId: string;
  readonly role?: string;
  readonly note?: string;
}

/** The lightweight snapshot stored with a binding: head bytes, hash, length. */
export interface ArtexTrafficSnapshot {
  readonly id: string;
  readonly sourceTrafficId: string;
  readonly capturedAt: number;
  readonly url: string;
  readonly method: string;
  readonly status: number;
  readonly contentType: string;
  readonly reqHead: string;
  readonly respHead: string;
  readonly reqHash: string;
  readonly respHash: string;
  readonly reqLen: number;
  readonly respLen: number;
}

export interface ArtexTrafficBinding {
  readonly id: number;
  readonly findingNodeId: number;
  readonly role: ArtexTrafficRole;
  readonly note: string;
  readonly position: number;
  readonly createdAt: string;
  readonly snapshot: ArtexTrafficSnapshot;
}

export interface ArtexVerbatimResult {
  readonly found: boolean;
  readonly trafficId: string;
  readonly side?: 'request' | 'response';
}
