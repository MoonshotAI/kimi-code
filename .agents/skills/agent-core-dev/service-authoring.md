# Topic — Service authoring

How to write a Service in `packages/agent-core-v2`: file layout, naming, what goes in the contract vs the impl, interface style, constructor / field conventions, events, multi-Service domains, and the comment rules. This is the day-to-day reference for stage 3 (implement.md covers the DI *mechanics*; this file covers the *authoring details*).

## File layout

One folder per domain, **camelCase**: `session/`, `sessionActivity/`, `contextMemory/`, `toolDedup/`. Inside, six kinds of files:

```text
<domain>/
├── <name>.ts            ← interface file: exactly one IXxx + its createDecorator + the types it owns
├── <name>Service.ts     ← impl file: exactly one class + exactly one registerScopedService(...)
├── <concern>.ts         ← pure function(s): no Service suffix, no class, no registration
├── <targetDomain>.ts    ← contribution file (common): registers into another domain's extension point
├── <what>.contrib.ts    ← contribution file (uncommon / ad-hoc)
└── <domain>.types.ts    ← shared types that no single interface owns
```

- **Strictly one service per file.** An interface file holds exactly one injectable interface and exactly one `createDecorator(...)`; an impl file holds exactly one service implementation class and exactly one `registerScopedService(...)`. No exceptions for "tightly-coupled" groups: even same-scope collaborators each get their own `<name>.ts` + `<name>Service.ts` pair.
- **Scope is in the filename.** `session*.ts` = Session, `agent*.ts` = Agent, no scope prefix = App (see [Naming](#naming)). The header comment restates the same scope.
- A domain therefore has as many impl files as it has services (e.g. `logService.ts` for the App `ILogService`, `sessionLogService.ts` for the Session `ISessionLogService`). See [Multi-Service domains](#multi-service-domains).

The package entry `src/index.ts` imports and `export *`s every domain's leaf files precisely (one line per leaf), so importing the package still runs every `registerScopedService(...)` side effect — exactly as the old per-domain barrels did.

## Naming

### Interfaces and classes

| Artifact | Rule | Example |
|---|---|---|
| Interface | `I` + scope prefix + PascalCase domain + role suffix. Scope prefix: `Session` / `Agent` / none (= App). Role suffix is usually `Service`. | `ISessionLogService`, `IAgentLoopService`, `ILogService` (App) |
| Class | the interface name minus the leading `I`, plus `Service` if it does not already end in `Service`; `implements` the interface | `SessionLogService implements ISessionLogService`, `AppendLogStoreService implements IAppendLogStore` |
| Decorator string | lowerCamelCase of the interface name minus the leading `I`; **globally unique and stable** (it surfaces in `CyclicDependencyError.path` and "no service registered" errors) | `createDecorator<ISessionLogService>('sessionLogService')` |
| Model / non-service types | PascalCase, no `I` prefix | `SessionMeta`, `LogEntry`, `ConfigSection` |

The scope prefix makes a service's lifetime readable from its name. App services carry **no** prefix (App is the default, longest-lived tier); Session and Agent services always carry `Session` / `Agent`. The prefix applies to the interface, the class, and therefore the file names.

> Do **not** use the scope prefix to re-merge domains by lifetime. `IAgentEntityService`, `IAgentDataService`, and `ISessionEntityService` are still banned — the prefix marks lifetime, the rest of the name must still be the real owning domain (`IBackgroundTaskEntityService`, `ISessionMetadata`, `IPermissionRulesService`). See [domain-boundaries.md](domain-boundaries.md).

### File names

File names derive from the interface / class names so that scope and role are visible in the tree:

| File kind | Rule | Example (interface → file) |
|---|---|---|
| Interface file | interface name minus leading `I`, minus trailing `Service` if present; acronym-aware lowerCamelCase | `ISessionLogService` → `sessionLog.ts`; `IAppendLogStore` → `appendLogStore.ts`; `ILogService` → `log.ts` |
| Impl file | the class name; acronym-aware lowerCamelCase | `SessionLogService` → `sessionLogService.ts`; `AppendLogStoreService` → `appendLogStoreService.ts` |
| Pure-function file | the function / concern name; no `Service` suffix | `formatLogEntry.ts`, `levelEnabled.ts` |
| Contribution file (common) | the **target** domain name | `config.ts` (registers a config section), `tool.ts`, `flag.ts` |
| Contribution file (uncommon) | `<what>.contrib.ts` | `slackWebhook.contrib.ts` |
| Shared-types file | `<domain>.types.ts` | `log.types.ts` |
| Errors file | `<name>.errors.ts` | `appendLogStore.errors.ts` |

Acronym-aware lowerCamelCase lowercases a leading acronym as a group: `ILLMRequester` → `llmRequester.ts`, `IWSGateway` → `wsGateway.ts`, `IOAuthToolkit` → `oauthToolkit.ts`, `IAgentRPCService` → `agentRpcService.ts`.

Because the impl class always ends in `Service` and the interface file never does, the two files of one service never collide — even for `Store` / `Registry` / `Resolver` interfaces (`IAppendLogStore` → `appendLogStore.ts` + `appendLogStoreService.ts`).

## The contract file (`<domain>.ts`)

Holds the public surface of the domain. A typical contract:

```ts
/**
 * `greet` domain (Ln) — one-line role.
 *
 * Defines the `Greeting` model and the `IGreeter` used by … Bound at … scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface Greeting {              // model — no _serviceBrand
  readonly message: string;
}

export interface IGreeter {              // injectable service — carries _serviceBrand
  readonly _serviceBrand: undefined;
  hello(): Greeting;
}

export const IGreeter: ServiceIdentifier<IGreeter> =
  createDecorator<IGreeter>('greeter');
```

What belongs here:

- **Model types** (`type` / `interface`) the domain exposes — `SessionMeta`, `LogEntry`, `ConfigSection`.
- **Service interface(s)** — the contract consumers depend on.
- **Decorator(s)** — one `createDecorator` per injectable service.
- **Helper types and pure functions** tightly bound to the contract — e.g. option bags, `satisfies`-checked seeds, predicate functions like `levelEnabled`.

### Which interfaces carry `_serviceBrand`

Only interfaces used as a **DI token** carry `readonly _serviceBrand: undefined`. Everything else does not:

- ✅ Service interface resolved via `@IX` / `accessor.get(IX)` → carries `_serviceBrand`.
- ❌ Base interface extended by a service (e.g. `ILogger` extended by `ILogService`) → no `_serviceBrand`.
- ❌ Plain model / data interface (`LogEntry`, `SessionMeta`) → no `_serviceBrand`.

```ts
export interface ILogger {                        // base interface — no brand
  info(message: string): void;
}
export interface ILogService extends ILogger {    // DI token — branded
  readonly _serviceBrand: undefined;
  setLevel(level: LogLevel): void;
}
```

## Interface style

- **Sync methods** return a concrete type; **async methods** return `Promise<T>`. Do not wrap a sync return in `Promise`.
- **Readonly fields** for immutable exposed state: `readonly ready: Promise<void>`, `readonly modelAlias: string | undefined`.
- **Optional members** with `?`: `flush?(): Promise<void>`, `close?(): Promise<void>`.
- **Generics** where the caller supplies the shape: `get<T = unknown>(domain: string): T`.
- **Extend** a base interface to share method groups: `interface ILogService extends ILogger`.
- **Events** as `readonly onDid…` / `onWill…` properties typed `Event<T>` — see [Events](#events).

```ts
export interface IConfigService {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<ConfigChangedEvent>;
  get<T = unknown>(domain: string): T;
  set(domain: string, patch: unknown): Promise<void>;
  reload(): Promise<void>;
}
```

## The impl file (`<domain>Service.ts`)

Holds the concrete class(es) and the top-level registration. A typical impl:

```ts
/**
 * `greet` domain (Ln) — `IGreeter` implementation.
 *
 * … collaborators as roles ("logs through `log`") … Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/log';

import { type Greeting, IGreeter } from './greet';

export class Greeter implements IGreeter {
  declare readonly _serviceBrand: undefined;

  constructor(@ILogService private readonly log: ILogService) {}

  hello(): Greeting {
    this.log.info('hello');
    return { message: 'hi' };
  }
}

registerScopedService(LifecycleScope.App, IGreeter, Greeter, InstantiationType.Eager, 'greet');
```

What belongs here:

- **Imports** — `InstantiationType` from `'#/_base/di/extensions'`; `LifecycleScope` + `registerScopedService` from `'#/_base/di/scope'`; collaborators via the `#/<domain>` alias; the contract's types + decorator via a relative `./<domain>` import.
- **Class** — `XxxService implements IXxxService`, with `declare readonly _serviceBrand: undefined`.
- **Helper classes / functions** used only by this impl (e.g. a built-in writer, an `extractError` helper) — co-located in the same file.
- **Top-level `registerScopedService(...)`** — one per Service the file owns; importing the impl file runs the registration.

## Constructor conventions

- Declare every dependency with `@IX` on a constructor parameter.
- Use `private readonly` (or `protected readonly`) to store a used dependency as a field.
- For an injected dependency the class does **not** directly use (e.g. passed through, or only needed to force construction order), drop the visibility modifier and prefix with `_`: `@IEventService _event: IEventService`.
- Service parameters and static parameters may both appear; the ordering rule depends on how the object is created — see below.

### Parameter order: scoped service vs `createInstance`

- **`registerScopedService` services** — the container injects only the `@IX` parameters; any static parameters must have defaults and are left at their default when the container builds the instance. Order is therefore not enforced by the container, but the common style is **`@IX` parameters first, optional static parameters after**:

  ```ts
  constructor(
    @ILogWriterService protected readonly writer: ILogWriterService,
    private readonly bound: LogContext = {},
    level: LogLevel = 'info',
  ) {}
  ```

- **`createInstance` objects** (non-singletons built with `instantiation.createInstance(Ctor, …staticArgs)`) — static parameters **must come first**, service parameters after, because the caller passes the static prefix positionally:

  ```ts
  constructor(
    private readonly input: string,                 // static — passed by caller
    @ILogService private readonly log: ILogService, // service — injected
  ) {}
  ```

### Factory methods

A scoped Service may expose a factory method that returns a **new** instance of itself (or a related class) with extra context bound — e.g. `ILogger.child(ctx)` returns `new LogService(this.writer, { …this.bound, …ctx }, this._level)`. This is not a DI violation: it is an explicit factory, not a request for the container to build a Service. Do not use it to circumvent scope or singleton semantics.

## Fields and state

- `private readonly` for fields set once at construction (injected deps, derived config).
- `private _name` (underscore prefix) for mutable private state: `private _level: LogLevel`.
- `readonly` public fields only for immutable exposed state; prefer a getter (`get level()`) when the value can change.
- Keep state minimal — a Service owns only the state that matches its scope's identity (design.md §2). Anything else belongs in a different Service.

## Events

v2 has two distinct event mechanisms. Pick by audience:

### `Event<T>` / `Emitter` — typed property on a Service

Use when a Service exposes a typed event its consumers subscribe to. Lives in `'#/_base/event'`.

```ts
// contract
import type { Event } from '#/_base/event';
export interface IConfigService {
  readonly onDidChange: Event<ConfigChangedEvent>;
}

// impl
import { Emitter, type Event } from '#/_base/event';
export class ConfigService extends Disposable implements IConfigService {
  private readonly _onDidChange = this._register(new Emitter<ConfigChangedEvent>());
  readonly onDidChange: Event<ConfigChangedEvent> = this._onDidChange.event;

  private notify(changed: ConfigChangedEvent): void {
    this._onDidChange.fire(changed);
  }
}
```

Conventions:

- Back the public `Event<T>` with a private `Emitter<T>`, registered with `this._register(...)` so it disposes with the Service.
- Naming: `onDid…` for "happened" (past tense, after the fact); `onWill…` for "about to happen" (may allow `waitUntil` participation / veto — see `AsyncEmitter` / `IWaitUntil` in `'#/_base/event'`).
- The Delayed-instantiation Proxy preserves early `onDid…` / `onWill…` subscriptions (implement.md §5).

### `IEventService` — global pub-sub bus

Use to broadcast protocol events across domains. Lives in `'#/event'`.

```ts
export interface IEventService {
  readonly _serviceBrand: undefined;
  publish(event: ProtocolEvent): void;
  subscribe(handler: (event: ProtocolEvent) => void): IDisposable;
}
```

Inject `@IEventService` and `publish(...)`; `subscribe(...)` returns an `IDisposable` to register with `this._register(...)`. This is the bus for "a fact happened, react if you care" (design.md §4) — not for typed per-Service events.

## Multi-Service domains

A domain may define several Services. Each Service gets its own pair of files regardless of scope or coupling:

- **One pair per Service** → `<name>.ts` for the contract + `<name>Service.ts` for the implementation.
- **Different scopes** → the scope prefix in the Service name makes this obvious (`logService.ts` for App `ILogService`, `sessionLogService.ts` for Session `ISessionLogService`).
- **Same interface, multiple role tokens** (e.g. `IAtomicDocumentStore` and `IAtomicTomlDocumentStore` share one interface type but are distinct DI tokens) → each token is its own Service identity and must be registered and resolved independently.

There is no `index.ts` barrel: consumers import each contract/impl from its precise leaf path (e.g. `import { ILogService } from '#/log/log'`), never the domain directory.

## No barrel — the package entry loads leafs precisely

A domain has **no `index.ts` barrel**. Its files are the contract leaf (`<name>.ts`) and the impl leaf (`<name>Service.ts`), and consumers import the precise file — never the directory:

```ts
import { IGreeter, type Greeting } from '#/greet/greet';
```

Self-registration is unchanged: `greetService.ts` keeps its top-level `registerScopedService(...)`. The package entry `src/index.ts` loads the domain's leafs precisely — `export *` for the contract, a side-effect `import` for the impl — one line per leaf:

```ts
// src/index.ts
export * from './greet/greet';
import './greet/greetService';
```

Importing the package therefore fires every `register*` side effect, exactly as the old per-domain barrels did. When you add a new domain, write the contract + impl leafs (with their top-level `register*`), then add the leaf path(s) to `src/index.ts`. **Do not create an `index.ts`.**

- Load the impl file too — its top-level `registerScopedService(...)` only runs when the module is imported.
- `export *` helper modules only if they are part of the domain's public surface.
- Each leaf's file-header comment still names the domain, scope, and (for impls) the `register*` binding it owns.

## Comments

- **File-header comment is mandatory** and the only place comments live (orient.md). State the identity line, the role, collaborators (impls), and scope.
- **Methods and fields carry no comments by default.** Well-named identifiers and types say *what*; the code is the source of truth for *how*.
- Write an inline comment only when the *why* is non-obvious (a hidden constraint, a subtle invariant, a workaround). One short line.
- For unimplemented stubs, throw `NotImplementedError('feature')` rather than `throw new Error('TODO: …')` (errors.md).

## Complete minimal example

```ts
// greet/greet.ts
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface Greeting { readonly message: string; }

export interface IGreeter {
  readonly _serviceBrand: undefined;
  hello(): Greeting;
}

export const IGreeter: ServiceIdentifier<IGreeter> = createDecorator<IGreeter>('greeter');
```

```ts
// greet/greetService.ts
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { type Greeting, IGreeter } from './greet';

export class Greeter implements IGreeter {
  declare readonly _serviceBrand: undefined;
  hello(): Greeting { return { message: 'hi' }; }
}

registerScopedService(LifecycleScope.App, IGreeter, Greeter, InstantiationType.Eager, 'greet');
```

```ts
// src/index.ts
export * from './greet/greet';
import './greet/greetService';
```

## Red lines (this topic)

- One folder per domain, camelCase; one service per file pair: contract `<name>.ts` + impl `<name>Service.ts`; **no `index.ts` barrel** — `src/index.ts` loads each leaf file precisely.
- Exactly one injectable interface and one `createDecorator(...)` per contract file.
- Exactly one service implementation class and one `registerScopedService(...)` per impl file.
- `IXxxService` / `XxxService` naming; decorator string is lowerCamelCase, globally unique, and stable.
- Name Services by owning domain, never by scope (`IAgentEntityService`, `ISessionEntityService`).
- `_serviceBrand` only on interfaces used as a DI token — never on base interfaces or plain models.
- Sync methods return concrete types, async return `Promise<T>`; do not `Promise`-wrap sync work.
- `createInstance` objects put static parameters before service parameters; scoped services put `@IX` parameters first (static params need defaults).
- Never `new` a `@IService`-carrying Service — except inside an explicit factory method, which is not a DI request.
- Events: typed per-Service event → `Event<T>`/`Emitter` from `'#/_base/event'`; cross-domain broadcast → `IEventService` from `'#/event'`.
- `src/index.ts` must import/export every leaf file (including the impl) so each `register*` side effect runs.
- File-header comment only; methods/fields carry no comments by default; stubs throw `NotImplementedError`.
