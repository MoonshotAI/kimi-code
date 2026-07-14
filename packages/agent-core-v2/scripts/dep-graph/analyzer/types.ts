/**
 * Shape of the dependency-graph data emitted by the analyzer and consumed by
 * the web viewer. Kept dependency-free so the same file can be imported from
 * Node (analyzer, Vite plugin) and the browser (React app).
 */

export type ServiceScope = 'App' | 'Session' | 'Agent';

export type EdgeKind =
  | 'ctor'
  | 'accessor'
  | 'publish'
  | 'subscribe'
  | 'emit'
  | 'on';

export interface ServiceNode {
  id: string;
  token: string;
  impl: string;
  scope: ServiceScope;
  domain: string;
  file: string;
  line: number;
  publicMembers?: string[];
  unresolved?: true;
  scopeMismatch?: true;
}

export interface EdgeRef {
  file: string;
  line: number;
  fromMethod?: string;
  toMethod?: string;
}

export interface Edge {
  from: string;
  to: string;
  token: string;
  kind: EdgeKind;
  unresolved?: true;
  scopeMismatch?: true;
  actualScope?: ServiceScope;
  refs: EdgeRef[];
}

export interface Graph {
  generatedAt: string;
  services: ServiceNode[];
  edges: Edge[];
  unknownTokens: string[];
}
