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
  transport (`DaemonHttpClient` / `DaemonEventSocket`), the wire mappers, and
  the state-machine primitives.
- `./contracts` — small dependency-free surfaces the consumer implements:
  `ClientIdentity`, `Tracer` (+ `noopTracer`), `CredentialStore`, `ResolveImage`.

## 1. API injection — `DaemonKimiWebApi`

The consumer constructs one `DaemonKimiWebApi` and threads its own tracer and
credential store through the constructor:

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
});
```

`tracer` (falls back to the no-op `noopTracer`) and `credentialStore` are
optional. Session content arrives over transcript subscriptions; the event
socket maps only global push events (`event.*`, `session.meta.updated`) into
`AppEvent`s.

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

## 3. Appearance composables

```ts
import { useAppearance, useIsDark } from '@moonshot-ai/app-core';
```

- `useIsDark()` — `Ref<boolean>` resolved against `<html data-color-scheme>`
  (falls back to light when the document carries no scheme). Shared singleton;
  read-only for consumers.
- `useAppearance()` — owns the scheme state + persistence; call once from the
  shell to start syncing `<html data-color-scheme>`.
