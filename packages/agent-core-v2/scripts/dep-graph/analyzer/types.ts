/**
 * Shape of the dependency-graph data emitted by the analyzer and consumed by
 * the web viewer. Kept dependency-free so the same file can be imported from
 * Node (analyzer, Vite plugin) and the browser (React app).
 */

export type ServiceScope = 'App' | 'Session' | 'Agent';

export type EdgeKind =
  /** `constructor(@IToken ...)` — declared DI dependency. */
  | 'ctor'
  /** `<scope>.accessor.get(IToken)` — runtime lookup. */
  | 'accessor'
  /** `<eventBus>.publish(...)` — publishes to `IEventService`. */
  | 'publish'
  /** `<eventBus>.subscribe(...)` — subscribes to `IEventService`. */
  | 'subscribe'
  /** `<eventSink>.emit(...)` — emits on `IAgentEventSinkService`. */
  | 'emit'
  /** `<eventSink>.on(...)` — listens on `IAgentEventSinkService`. */
  | 'on';

export interface ServiceNode {
  /**
   * Stable unique node id. One `registerScopedService` call = one node.
   * Format: `${scope}::${token}` — matches the DI registration identity and
   * disambiguates the same impl class bound to multiple tokens (e.g.
   * `InMemoryStorageService` registered against 4 different tokens) as well
   * as the same token bound at multiple scopes (e.g. `ILogWriterService`
   * bound at App and Session).
   */
  id: string;
  /** Token identifier (e.g. `IAgentSystemReminderService`). */
  token: string;
  /** Impl class name (e.g. `AgentSystemReminderService`). */
  impl: string;
  scope: ServiceScope;
  /** First folder under `src/` (e.g. `systemReminder`). */
  domain: string;
  /** Repo-relative path of the impl file. */
  file: string;
  /** 1-indexed line of the `registerScopedService(...)` call. */
  line: number;
}

export interface EdgeRef {
  /** Repo-relative path where the reference occurs. */
  file: string;
  line: number;
}

export interface Edge {
  /** Source `ServiceNode.id` (impl-side, not token). */
  from: string;
  /**
   * Resolved target `ServiceNode.id` — the concrete registration that the
   * DI container would actually pick when the source is instantiated. For
   * `unresolved: true` edges this is the token that couldn't be resolved,
   * prefixed with `unresolved::` for visualisation purposes.
   */
  to: string;
  /** The interface/decorator name that appears at the source site. */
  token: string;
  kind: EdgeKind;
  /**
   * True when there is no impl registered for `token` at a scope visible
   * from the source (walking source scope up to root). A `ctor` edge in
   * this state would crash the container at instantiation time.
   */
  unresolved?: true;
  /** One or more locations that produced this edge (deduped). */
  refs: EdgeRef[];
}

export interface Graph {
  /** Wall-clock, but injected from the analyzer caller so the file is deterministic. */
  generatedAt: string;
  services: ServiceNode[];
  edges: Edge[];
  /** Tokens referenced by edges but not registered — usually external / test-only. */
  unknownTokens: string[];
}
