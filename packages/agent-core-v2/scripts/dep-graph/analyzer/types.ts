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
  /** `<record>.signal(...)` / `<record>.append(...)` — emits on `IAgentRecordService`. */
  | 'emit'
  /** `<record>.on(...)` — listens on `IAgentRecordService`. */
  | 'on';

export interface ServiceNode {
  /**
   * Stable unique node id. One `registerScopedService` call = one node.
   * Format: `${scope}::${token}` — matches the DI registration identity and
   * disambiguates the same impl class bound to multiple tokens (e.g.
   * `InMemoryStorageService` registered against 4 different tokens) as well
   * as the same token bound at multiple scopes (e.g. `ILogService`
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
  /**
   * Public callable surface of this service — the method/property names
   * declared on the interface identified by `token`. Sorted, deduped, with
   * the `_serviceBrand` DI marker filtered out. Absent when the analyzer
   * couldn't locate an interface declaration for the token (e.g. synthetic
   * framework bindings whose token has no interface in `src/`).
   */
  publicMembers?: string[];
  /**
   * True for synthesized interface-only nodes: the token is referenced by at
   * least one edge but has no implementation registered at any scope. These
   * nodes have no real impl (so `impl` mirrors `token`) and the viewer renders
   * them with a distinct border so missing bindings stand out from concrete
   * services rather than being dropped as dangling edges.
   */
  unresolved?: true;
  /**
   * True for synthesized scope-mismatch nodes: the token IS registered, but at
   * a scope invisible to the edge's source. Rendered distinctly (and placed at
   * the token's real registered scope) so a cross-scope reach reads differently
   * from a genuinely missing implementation.
   */
  scopeMismatch?: true;
}

export interface EdgeRef {
  /** Repo-relative path where the reference occurs. */
  file: string;
  line: number;
  /**
   * Method on the source impl that contains this reference — the caller.
   * `<ctor>` for the constructor, `get <name>` / `set <name>` for accessors,
   * `<field <name>>` for a property initializer, or the plain method name.
   * Absent for the ctor-param declaration refs and for refs the analyzer
   * couldn't attribute to a named scope.
   */
  fromMethod?: string;
  /**
   * Method invoked on the target service at this ref site.
   *  - `ctor` edge: the method the source calls on the injected field,
   *    e.g. `this.log.error(...)` → `error`.
   *  - `accessor` edge: the method chained on `<accessor>.get(IX).<method>()`.
   * Absent for the pure declaration ref (the ctor param), for the pure
   * lookup ref (a `get()` whose result is stored rather than called), and
   * for event-bus edges where the method name is already the edge kind.
   */
  toMethod?: string;
}

export interface Edge {
  /** Source `ServiceNode.id` (impl-side, not token). */
  from: string;
  /**
   * Resolved target `ServiceNode.id` — the concrete registration that the
   * DI container would actually pick when the source is instantiated. For
   * `unresolved: true` edges this is the token that couldn't be resolved,
   * prefixed with `unresolved::`; for `scopeMismatch: true` edges it is
   * prefixed with `scopeMismatch::`.
   */
  to: string;
  /** The interface/decorator name that appears at the source site. */
  token: string;
  kind: EdgeKind;
  /**
   * True when there is no impl registered for `token` at ANY scope — the
   * token is simply unknown to the container. A `ctor` edge in this state
   * would crash the container at instantiation time.
   */
  unresolved?: true;
  /**
   * True when the token IS registered, but only at a scope that is not
   * visible from the source (e.g. an App-scope service reaching for an
   * Agent-scope token through an accessor whose scope the analyzer couldn't
   * pin down). Distinct from `unresolved`: an implementation exists, the
   * edge just can't be satisfied from where it is requested.
   */
  scopeMismatch?: true;
  /** When `scopeMismatch`, the innermost scope where `token` is registered. */
  actualScope?: ServiceScope;
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
