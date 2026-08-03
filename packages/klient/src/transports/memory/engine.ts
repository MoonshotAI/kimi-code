/**
 * Engine access contract for the in-process transports.
 *
 * The retired `@moonshot-ai/agent-core-v2` engine is not a klient
 * dependency. The memory dispatcher routes wire `(service, method, args)`
 * triples to engine services by DI token, and those tokens (plus the
 * `main`-agent materializer) are supplied by the host at call time — the
 * host is the process that bootstrapped the engine. Every type here is
 * structural, so a real engine scope satisfies it without klient importing
 * the engine package.
 */

/** Structural mirror of the engine's `ServiceIdentifier<T>` DI token. */
export interface ServiceIdentifier<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (target: any, key: string | symbol | undefined, index: number): void;
  readonly type: T;
  toString(): string;
}

/** A DI token whose service type is not statically known; engine tokens are assignable to it. */
export type EngineToken = ServiceIdentifier<unknown>;

/** Structural minimum of an engine scope (`IScopeHandle`): the DI accessor. */
export interface ScopeLike {
  readonly accessor: {
    get<T>(id: ServiceIdentifier<T>): T;
  };
}

/**
 * Engine glue a host must supply to drive the in-process dispatcher: the
 * wire service-name → token map, the handful of tokens the dispatcher
 * itself touches (scope resolution, event streams), and the `main`-agent
 * materializer. Hosts build this from the engine package (e.g.
 * `test/helpers/engine.ts`); klient never imports the engine.
 */
export interface MemoryEngineAccess {
  /** Wire service name (decorator id string) → engine DI token. */
  readonly serviceTokens: Readonly<Record<string, EngineToken>>;
  /** App-level event bus token (`IEventService`). */
  readonly eventServiceToken: EngineToken;
  /** Agent-level event bus token (`IEventBus`). */
  readonly eventBusToken: EngineToken;
  /** Session interaction service token (`ISessionInteractionService`). */
  readonly sessionInteractionServiceToken: EngineToken;
  /** Session lifecycle service token (`ISessionLifecycleService`). */
  readonly sessionLifecycleServiceToken: EngineToken;
  /** Agent lifecycle service token (`IAgentLifecycleService`). */
  readonly agentLifecycleServiceToken: EngineToken;
  /** Materialize the `main` agent on a session handle (engine `ensureMainAgent`). */
  readonly ensureMainAgent: (session: ScopeLike) => Promise<ScopeLike>;
}
