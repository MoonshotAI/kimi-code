# Topic — Config

How the `config` domain works and how a domain owns its configuration section. Covers the section-registry model, the App vs Session split, the TOML on-disk format, and the recipe for adding or migrating a config section.

The `config` domain is a thin registry + loader: it does **not** know the shape of any individual section. Each domain owns the schema (and, where needed, the TOML transform) for the config it consumes, registers the section into `IConfigRegistry`, and reads it through `IConfigService`. There is no whole-config object passed around.

## What belongs in Config

`IConfigService` is the **preference registry**: it holds values a user or
operator *chooses*, each with a schema and a default, that *can* be persisted to
`config.toml`. It is not a grab-bag for every value a domain needs. Before
registering a section, classify the value along three axes — **decision-maker**,
**preference vs fact**, **mutability / persistence**:

| Type | Decision-maker | Preference/Fact | Persisted? | Examples | Home |
|---|---|---|---|---|---|
| User preference | user | preference | ✅ config.toml | model, theme, log level | **Config** |
| Operational override | operator/deployer | preference | ❌ env / flag | `KIMI_MODEL_*`, `KIMI_LOG_*` | **Config** (env overlay) |
| Per-run intent | invoker | preference | ❌ ephemeral | CLI `--model`, `--config` | **Config** (Memory layer) |
| Host fact | host | fact | ❌ | platform, CI, proxy, home dir | **Bootstrap** |
| Derived convention | code | fact (derived) | ❌ | `configPath`, `logsDir` | **Bootstrap / code** |
| Session runtime state | session/agent | state | ✅ session meta | active model, plan mode | **Session scope** |
| Tuning constant | developer | preference | ❌ compile-time | retry backoffs, buffer sizes | **code** |

A value belongs in Config **iff** it satisfies all of:

1. **Preference** — a choice among valid values, not an observed fact.
2. **Persistable** — it *can* be written to `config.toml`, even when a given
   value arrives via env or CLI.
3. **Schema + default** — registerable as a section with validation.
4. **User- or operator-facing** — meaningful to set as a preference.

If it fails any rule, it is not Config:

- **Fact** (CI, platform, proxy, `HOME`) → a structured fact on
  `IBootstrapService` (the L1 startup snapshot), not Config.
- **Derived convention** (`configPath`, `logsDir`) → `IBootstrapService` / code.
- **Session runtime state** (active model, plan mode) → a Session-scoped
  service in the owning domain (e.g. `IProfileService`), not `config`.
- **Tuning constant** (retry config, buffer sizes) → domain code; promote to
  Config only when it becomes user-tunable.

**`IBootstrapService` is domain-agnostic.** It holds only generic facts shared by
all domains — the env bag, resolved paths, and host facts (`platform`, `arch`,
`cwd`, `osHomeDir`, `isCI`, …). It must **never** hold state tied to a specific
upper domain (no `cron`, no `flags`, no feature-specific fields): that couples
the foundational layer to an upstream one.

Any value that belongs to a specific domain — including env-only operational
toggles (`KIMI_CRON_*`, `KIMI_CODE_EXPERIMENTAL_*`), model parameters, or feature
flags — goes through **Config registration**: the owning domain registers a
section with a declarative `envBindings` map (and a `stripEnv` when the value must
not be persisted) and reads it via `config.get(...)`. Each config value declares
an optional env binding (`{ field: 'ENV_VAR' }`, with optional `parse`/`default`);
IConfig resolves each field by `env > config.toml > default` automatically. This
keeps every domain's config in one registry and keeps Bootstrap free of upstream
knowledge.

Operational env overrides and per-run intent live *inside* Config as layers over
the same persistable key: `model` can be set in `config.toml`, via `KIMI_MODEL_*`,
or via CLI `--model`. They are not separate abstractions — see "Reads vs writes"
and "Layered resolution" below.

Env access is encapsulated: business domains read `config.get(...)` or structured
`IBootstrapService` facts; only the `config` domain reads the raw env bag (from
`IBootstrapService`) to build its overlays. Business domains must not call
`IBootstrapService.getEnv()` directly.

## Layered resolution

`IConfigService` resolves a key by precedence across layers, lowest to highest:

```text
Default   registered defaultValue (and code constants promoted to a section)
   ↓
User      config.toml (persisted user preferences)
   ↓
Operational env overlay (e.g. KIMI_MODEL_*, KIMI_CODE_EXPERIMENTAL_*)
   ↓
Memory    per-run intent (CLI flags); never persisted; highest
```

`set(domain, patch, target?)` writes the `User` layer (persisted) by default;
pass `ConfigTarget.Memory` for a per-run override that is never written to disk.
`inspect(domain)` reports the value at each layer.

## Layout

- `src/config/config.ts` — `IConfigRegistry` / `IConfigService` tokens, `ConfigSection`, `ConfigEffectiveOverlay`, event types.
- `src/config/configService.ts` — `ConfigRegistry` + `ConfigService` impl; self-registers at App scope.
- `src/config/toml.ts` — generic snake_case ↔ camelCase machinery plus the registry-aware `transformTomlData` / `applySectionToToml` entry points. Per-domain normalization lives in the section owner's `configSection.ts` (registered as `fromToml` / `toToml`); this module stays free of any other domain's semantics.
- `src/profile/thinking.ts` (owner domain, not `config`) — the `resolveThinkingEffort` helper; uses the authoritative `ThinkingConfig` from `configSection.ts`.
- `src/config/configPure.ts` — `isPlainObject`, `deepMerge`, `omitUndefined`, `describeUnknownError`.

A domain that owns a section keeps the schema in its own `configSection.ts` (e.g. `src/flag/flag.ts` for `experimental`, `src/loop/configSection.ts` for `loopControl`). Exception: kosong-owned sections (`providers`, `models`, `thinking`) — kosong is a pure, persistence-free abstraction layer that defines only the types (`src/kosong/{provider,model}`); the section constants, the zod schemas (re-derived from those types and compile-time pinned via `AssertExact<Equal<z.infer<typeof Schema>, Type>>`, see `_base/utils/typeEquality.ts`), the registrations, env bindings, and TOML transforms all live in the persistence wrapper `src/app/kosongConfig/configSection.ts`. (`modelCatalog` and `secondaryModel` have no kosong-side type at all — their sections are fully self-contained in `app/kosongConfig`, types derived from the schemas.) A cross-section env overlay (e.g. the `KIMI_MODEL_*` synthesis) lives in the wrapper too (`src/app/kosongConfig/envOverlay.ts`; the `[secondary_model]` derived-entry synthesis in `secondaryModelOverlay.ts`) and is registered via `IConfigRegistry.registerEffectiveOverlay`. The two-way sync between config sections and kosong's in-memory registries is owned by `IKosongConfigService` (`src/app/kosongConfig/kosongConfigService.ts`).

## Scope

- `IConfigRegistry` / `IConfigService` — **App** scope, process-global. One registry of sections; one loader reading `~/.kimi-code/config.toml` (path from `IBootstrapService.configPath`).

All config reads go through `IConfigService` (global config). Per-session runtime state (active model, thinking level, etc.) lives in the owning Session-scoped service (e.g. `IProfileService`), not in `config`.

## The section-registry model

A config section is identified by a camelCase domain key (`'providers'`, `'thinking'`, `'loopControl'`). Each section has:

- `schema?: ConfigSchema<T>` — zod schema used to validate the value (absent ⇒ passthrough).
- `defaultValue?: T` — filled when the file has no value for the domain.
- `merge?: ConfigMerge<T>` — how `set(domain, patch)` combines base + patch (default `deepMerge`).
- `fromToml?: ConfigFromToml` — read-path transform (snake_case file value → in-memory shape). Defaults to a plain key-casing pass; owners register one when the on-disk shape needs custom normalization (record key preservation, nested object conversion, array entries, key renames, reshapes).
- `toToml?: ConfigToToml` — write-path transform (in-memory value → snake_case file value). Defaults to a plain camelCase→snake_case key mapping.

Ownership rules:

- **One owner per section.** `registerSection` throws if a domain is registered twice.
- **The domain that consumes a config owns its schema.** This is what keeps `config` (L2) from importing higher domains: `config` must not import `externalHooks` / `permissionRules` / `provider` / `kosong` / etc. for a section's schema. If a schema needs a domain's types, the schema lives in that domain.
- **Demand-driven.** Do not register sections for config that no domain reads yet; a section appears (with its schema in the owning domain) only when a consumer appears.

## Env bindings

A section can declare how its fields are read from environment variables, so the
value resolves through `config.get(...)` rather than ad-hoc `process.env` reads.
Declare the bindings with `envBindings(schema, { … })` — the field names are
type-checked against the schema (no magic strings), and nested schemas recurse:

```ts
registerSection('thinking', ThinkingConfigSchema, {
  env: envBindings(ThinkingConfigSchema, {
    effort: 'KIMI_MODEL_THINKING_EFFORT',
  }),
});

// nested / record section — outer key is a runtime constant, inner fields are
// checked against the value schema:
registerSection('providers', ProvidersSectionSchema, {
  env: envBindings(ProvidersSectionSchema, {
    [ENV_MODEL_PROVIDER_KEY]: envBindings(ProviderConfigSchema, {
      apiKey: 'KIMI_MODEL_API_KEY',
      type:   'KIMI_MODEL_PROVIDER_TYPE',
      baseUrl:'KIMI_MODEL_BASE_URL',
    }),
  }),
  stripEnv: stripProvidersEnv,
});
```

Each field is an `EnvBinding` — a string (env var name) or
`{ env, parse?, default? }`. IConfig resolves every field by
`env > config.toml > default`, sets it on the effective value, and validates the
section. Empty nested entries (no field resolved) are omitted, so a synthetic
entry like `__kimi_env__` only appears when at least one of its env vars is set.

`stripEnv(value, raw?, getEnv?)` removes env-derived fields before `set`/`replace`
persists, so env overrides never leak into `config.toml`. `raw` is the section's
env-free camelCase base (already `fromToml`-normalized, so legacy key renames
are honored), and `getEnv` reads the live env bag. For fields that are **both
user-persistable and env-overridable**, register
`stripEnv: stripEnvBoundFields(sectionEnvBindings)` (from `#/app/config/config`)
— it derives the guard from the same bindings the read path uses: while a
field's env var resolves to a value, writes restore the field's raw-base value
(or drop it) instead of persisting an echoed env value; an env value that
fails the binding's `parse` owns nothing, so writes pass through. Env-only
fields/sections need no env check — strip them unconditionally (e.g. thinking's
`forcedEffort`, cron's whole-section `() => undefined`).

Business domains read `config.get('section')`; they never read env directly, and
never write their own env-merge logic.

## Add a config section (recipe)

1. Define the schema in the owning domain, e.g. `src/<domain>/configSection.ts`:
   ```ts
   export const MY_SECTION = 'mySection';
   export const MySectionSchema = z.object({ /* ... */ });
   export type MySection = z.infer<typeof MySectionSchema>;
   ```
2. In the domain's service constructor, inject `IConfigRegistry` and register:
   ```ts
   constructor(@IConfigRegistry registry: IConfigRegistry) {
     registry.registerSection(MY_SECTION, MySectionSchema, { defaultValue: {} });
   }
   ```
   Pick a service whose scope matches when the config is first needed. Registering from an Agent-scope service is fine — see "Late registration".
3. Read it anywhere via `IConfigService`:
   ```ts
   constructor(@IConfigService private readonly config: IConfigService) {}
   // ...
   const value = this.config.get<MySection>(MY_SECTION);
   ```
4. React to edits by subscribing `IConfigService.onDidChange` and filtering on `e.domain === MY_SECTION` (see `FlagService`).
5. Write it only through `IConfigService.set(domain, patch)` (merge) or `.replace(domain, value)` (wholesale). Never write `config.toml` directly.

## Reads vs writes

Data flow is one-way by default — reading config never touches the file:

```text
config.toml  ──load──▶  IConfigService.effective  ──get──▶  services read
   ▲                                                          │
   └────────  IConfigService.set/replace  ◀────  only on explicit writes
```

- **Read path** (startup, every service): `config.toml` is loaded into `IConfigService` once; services read via `get()`. This path **never writes the file**.
- **Write path** (rare): `config.toml` is rewritten only when something explicitly calls `IConfigService.set/replace`. The only production writers today are provider CRUD (`ProviderService.set/delete`, e.g. provisioning a provider after OAuth login).

**Runtime service state is not config.** Mutating a service at runtime does **not** rewrite `config.toml`:

- `ProfileService.configure(...)` / `update(...)` / `setModel(...)` / `setThinking(...)` only change **in-memory** fields and append to the session **wireRecord** (for replay). They never call `IConfigService.set`.
- Switching model or thinking level mid-session is session runtime state, not a config edit — the user's `config.toml` is left untouched.

So `configure(...)` never overwrites the local file. Treat `config.toml` as the user's static config; runtime overrides live in memory and the session record.

## Late registration

`ConfigService` loads in its constructor (first `get(IConfigService)`). Domain services that register sections may be constructed later (especially Agent-scope services). To keep validation and defaults correct:

- `IConfigRegistry` emits `onDidRegisterSection` whenever a section is registered.
- `ConfigService` subscribes and, on registration, re-validates the already-loaded raw value for that domain, applies the default if the raw value is absent, re-runs the env overlay, and fires `onDidChange` if the effective value changed.
- Before a section is registered, `get(domain)` returns the raw (transformed, unvalidated) value; consumers that need validated values should read after the owning service is constructed, or react to `onDidChange`.

This means registration order is never a correctness concern — you do not need an eager bootstrap.

## TOML on-disk format

`config.toml` stores keys in **snake_case**; in-memory values are **camelCase**. `ConfigService` converts both ways by dispatching to each section's registered transform:

- **Read**: `transformTomlData(fileData, registry)` maps each top-level key to a domain and applies that domain's `fromToml` hook (or a plain key-casing pass when none is registered). Owner domains register their own normalization — e.g. provider `oauth`/`env`/`customHeaders`, permission `deny/allow/ask` → `rules`, `loop_control.max_steps_per_run` → `maxStepsPerTurn`, `experimental` keys preserved verbatim. When a section registers after the initial load, `ConfigService` re-applies its `fromToml` against the preserved snake_case raw value (see "Late registration"), so registration order is never a correctness concern.
- **Write**: `applySectionToToml(rawSnake, domain, value, registry)` applies the domain's `toToml` hook (or a plain camelCase→snake_case mapping) into a raw clone of the file, preserving unknown top-level keys and unknown sub-fields (lossless round-trip).

`ConfigService` keeps four views:

- `rawSnake` — snake_case clone of the file; the write base, never carries the env overlay.
- `raw` — camelCase, env-free; the read/set/replace base.
- `validated` — validated `raw`, env-free; the base every live env re-application starts from, so a degraded or removed env value falls back to the file instead of a stale overlay.
- `effective` — `validated` plus the env overlay, recomputed on load/set; `get()`/`getAll()` re-apply the overlay on a fresh `validated` copy per read rather than caching it.

### `KIMI_MODEL_*` env overlay

When `KIMI_MODEL_NAME` is set, the `kosongConfig` wrapper's `kimiModelEnvOverlay` (`src/app/kosongConfig/envOverlay.ts`) injects a reserved model alias (`__kimi_env_model__`) into `effective`, points `defaultModel` at it, and merges the request `modelOverrides`; the reserved provider (`__kimi_env__`) comes from the `providers` section env bindings. The overlay is registered via `IConfigRegistry.registerEffectiveOverlay` and applied **only to `effective`**, never to `rawSnake`, so it is never persisted. Its `strip` (plus the providers section `stripEnv`) is the final guard so a caller that read `effective` (with the overlay) cannot write the reserved entries or the shell API key back to disk. `config` itself only runs registered overlays — it does not know the `KIMI_MODEL_*` semantics.

## Owner-owned sections

`config` holds no monolithic config schema and no whole-config object. Every section is owned by the domain that consumes it: the schema (and any `fromToml` / `toToml` normalization and `stripEnv`) lives in that domain's `configSection.ts`, and the domain registers it via `IConfigRegistry.registerSection`. Cross-section env behavior (e.g. `KIMI_MODEL_*`) lives in an owner-registered `ConfigEffectiveOverlay`. To add a section, follow "Add a config section" above in the owning domain — never add schema or normalization to `config` itself.

## Ownership map (generated)

The authoritative, always-current list of registered sections — rendered in the on-disk `config.toml` shape, with owner file, scope, defaults, env bindings, and schema fields — is generated from the live registry:

- `packages/agent-core-v2/docs/config-manifest.toml` (checked in; do not edit by hand).
- Regenerate with `pnpm --filter @moonshot-ai/agent-core-v2 gen:config-manifest` (add `--check` for a freshness check; `test/app/config/configManifest.test.ts` enforces it in CI).

`config` must not import from any of these owner domains; that is the whole reason the schemas, TOML normalization, and env overlays live with their owners.

## Layering & scope

- `config` is **L2**. Domains that own sections import `config` (for `IConfigRegistry` / `IConfigService`) and must be at L2 or higher; lower layers need an entry in `ALLOWED_EXCEPTIONS` (e.g. `kosong>config`, `kosong>provider`).
- Cross-domain type sharing for a config type may need an exception too (e.g. `plugin>mcp` for `McpServerConfig`). Prefer importing the type from the owning domain over re-declaring it.
- `IConfigRegistry` / `IConfigService` are **App**. Agent scope services may inject App services via ancestor lookup.
- `config` never imports a higher domain and holds no section schemas of its own; if a section needs a type from another domain, that schema lives in that domain.

## Red lines (this topic)

- One owner per section; `registerSection` throws on duplicate domains.
- `config` (L2) never imports a higher domain — keep section schemas in the owning domain.
- Config is the **preference registry**: register only values that are preferences, persistable, schema'd, and user/operator-facing. Facts → `IBootstrapService`; session state → Session scope; constants → code.
- Business domains read `config.get(...)` or structured `IBootstrapService` facts; never call `IBootstrapService.getEnv()` directly — only `config` reads the raw env bag to build overlays.
- Keep `IBootstrapService` domain-agnostic: never add state tied to a specific upper domain (cron, flags, model params, …). Domain-specific config goes through `registerSection` + `envBindings`, read via `config.get(...)`.
- Do not pass a whole config bag via options; read each section through `IConfigService`. There is no `KimiConfig` object — config is a registry of owner-owned sections.
- `config.toml` is snake_case on disk, camelCase in memory — never write camelCase keys to disk, and never write to `config.toml` except through `IConfigService.set/replace`.
- Reading config / calling `configure(...)` / switching model at runtime must not rewrite `config.toml`; runtime state lives in memory and the session wireRecord, not the file.
- Never persist env overlays (`__kimi_env__` / `__kimi_env_model__` / shell API key / experimental env); overlays live only in `effective` / `Memory`.
- Registering from an Agent-scope service is fine — the late-registration mechanism keeps validation correct; do not add an eager bootstrap.
