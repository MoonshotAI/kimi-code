# @moonshot-ai/app-core

Source-only shared core for the Kimi web apps. `exports` points at `./src/*`
(subpaths `.`, `./api`, `./contracts`), so the consumer's bundler transpiles it;
`vue` / `vue-i18n` are peer dependencies. It owns the daemon transport, the pure
session state machine, a state-container factory, and a couple of
framework-agnostic composables. It never imports a consumer's tracer, credential
store, i18n, or tool labeling — those are injected.

## Exports

- `.` — re-exports `api`, `client`, `composables`, `contracts`.
- `./api` — `DaemonKimiWebApi` (+ `DaemonKimiWebApiOptions`), the daemon
  transport (`DaemonHttpClient` / `DaemonEventSocket`), the projector / mapper
  types, and the state-machine primitives.
- `./contracts` — small dependency-free surfaces the consumer implements:
  `ClientIdentity`, `Tracer` (+ `noopTracer`), `CredentialStore`, `ResolveImage`.

## 1. API injection — `DaemonKimiWebApi`

The consumer constructs one `DaemonKimiWebApi` and threads its own tracer,
credential store, and agent-event projector through the constructor:

```ts
import { DaemonKimiWebApi } from '@moonshot-ai/app-core/api';
import {
  noopTracer,
  type CredentialStore,
  type Tracer,
} from '@moonshot-ai/app-core/contracts';

const api = new DaemonKimiWebApi({
  origin: 'http://127.0.0.1:58627',
  identity: { clientId, clientName, clientVersion, clientUiMode },
  tracer: myTracer,                   // optional; defaults to noopTracer
  credentialStore: myCredentialStore, // optional; { getToken(), markAuthRequired?() }
  projectorFactory: createAgentProjector, // REQUIRED: () => AgentProjector
});
```

`tracer` (falls back to the no-op `noopTracer`) and `credentialStore` are
optional; `projectorFactory` is **required** — the daemon event socket calls it
per subscription to turn raw agent-core frames into `AppEvent`s.

## 2. State-machine foundation

The reducer is pure and free of DOM / transport side effects:

```ts
import {
  createInitialState,
  reduceAppEvent,
  type KimiClientState,
} from '@moonshot-ai/app-core/api';

const state = createInitialState();                         // KimiClientState
const next = reduceAppEvent(state, event, meta);            // ctx optional
const nextI18n = reduceAppEvent(state, event, meta, { t }); // inject translator
```

`reduceAppEvent(state, event, meta, ctx?)` returns the next `KimiClientState`.
The optional `ctx.t` (`(key, params?) => string`) translates reducer-emitted
warning labels and defaults to identity (`DEFAULT_REDUCE_CONTEXT`).

## 3. State container — `createKimiWebClientCore`

A per-instance reactive wrapper around the state machine. Two calls never share
state (no module-level singleton):

```ts
import { createKimiWebClientCore } from '@moonshot-ai/app-core';

const core = createKimiWebClientCore({ api, t, tracer }); // t?, tracer? optional
core.apply(event, meta); // reduce one daemon event into core.state
```

`install()` / `dispose()` are intentional no-ops — the transport subscription
and cross-tab / visibility listeners stay in the consumer shell, so the core has
no DOM / transport side effects and is trivially testable. The `api` is held so
the shell can share one instance; the core does not call into it directly (the
shell feeds events via `apply`). Wiring up the event connection is left to the
shell and to later phases.

## 4. Appearance composables

```ts
import { useAppearance, useIsDark } from '@moonshot-ai/app-core';
```

- `useIsDark()` — `Ref<boolean>` resolved against `<html data-color-scheme>`
  (falls back to light when the document carries no scheme). Shared singleton;
  read-only for consumers.
- `useAppearance()` — owns the scheme state + persistence; call once from the
  shell to start syncing `<html data-color-scheme>`.
