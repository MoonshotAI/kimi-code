# Topic — Flags

Experimental feature-flag gating for agent-core-v2 — an App-scope `IFlagService` resolver plus a writable `IFlagRegistry` catalog that domains contribute their flags to, backed by the `[experimental]` config section.

Gate not-yet-public features behind `IFlagService.enabled(id)`, per the repository hard rule that unreleased behavior must be flag-gated. v1 was a process-global `FlagResolver` singleton over a central `FLAG_DEFINITIONS` array; v2 is a scoped DI service whose flag definitions are registered **decentrally** by each owning domain — there is no central catalog to edit.

## Layout

- `src/flag/flagRegistry.ts` — `IFlagRegistry` token + `FlagDefinitionInput` / `FlagId` / `FlagSurface` types + `registerFlagDefinition` / `getContributedFlags` (import-time contribution queue).
- `src/flag/flagRegistryService.ts` — `FlagRegistryService` impl; in-memory catalog seeded from import-time contributions; App scope.
- `src/flag/flag.ts` — `IFlagService` token + resolver types (`ExperimentalFlagMap`, `ExperimentalFlagConfig`, `ExperimentalFlagSource`, `ExperimentalFeatureState`) + `ExperimentalConfigSchema` / `ExperimentalConfig` (zod).
- `src/flag/flagService.ts` — `FlagService` impl + `MASTER_ENV` (`KIMI_CODE_EXPERIMENTAL_FLAG`) + `EXPERIMENTAL_SECTION` (`experimental`); reads definitions from `IFlagRegistry`; self-registers at App scope.
- `src/flag/index.ts` — **removed (no barrel)**; `src/index.ts` imports the `flag` leafs precisely instead (e.g. `import './flag/flagService'`).
- `src/<domain>/flag.ts` — each domain that owns a flag declares it here and calls `registerFlagDefinition` at the module top level (e.g. `src/multiServer/flag.ts`). The directory already names the domain, so the file is just `flag.ts`.

## Public surface

- `IFlagService` (DI token, App scope): `enabled(id)`, `explain(id)`, `snapshot()`, `enabledIds()`, `explainAll()`, `setConfigOverrides(overrides)`, `registry`.
- `IFlagRegistry` (DI token, App scope): `register(definition)`, `get(id)`, `list()` — writable catalog. `register` is the **runtime** path (tests, dynamic registration); `IFlagService.registry` exposes the same instance for hosts/UI to enumerate flags without resolving them.
- `registerFlagDefinition(definition)` — the **import-time** path. Domains call this from their `flag.ts` top level; contributions are queued and drained by `FlagRegistryService` when it is instantiated.
- `FlagService` / `FlagRegistryService`: exported for tests and hosts that construct them directly.

## Resolution precedence

Highest wins; env is read live on every call (nothing cached):

1. Master env `KIMI_CODE_EXPERIMENTAL_FLAG` truthy → every flag on.
2. Per-feature `def.env` (e.g. `KIMI_CODE_EXPERIMENTAL_MY_FEATURE`) → forces on/off.
3. `[experimental]` config section per-flag override.
4. Registry `default`.

`explain(id)` returns the winning `source` (`master-env` | `env` | `config` | `default`) plus the effective `configValue`. `explain(id)` returns `undefined` (and `enabled(id)` returns `false`) for an id that no domain has registered.

## Config integration

- `FlagService` registers the `[experimental]` section into `IConfigRegistry` at construction (`registerSection('experimental', ExperimentalConfigSchema)`) and reads overrides from `IConfigService`.
- It subscribes `IConfigService.onDidChange` and refreshes overrides whenever the `experimental` domain changes, so config edits apply live.
- `IConfigRegistry.registerSection` throws if a domain is registered twice — `experimental` is owned exclusively by `FlagService`.
- `setConfigOverrides(overrides)` is an imperative escape hatch for tests and hosts without an `IConfigService`; hosts on `IConfigService` should set the `[experimental]` section instead.

Config shape:

```toml
[experimental]
my_feature = false
```

Keys are intentionally loose (`z.record(z.string(), z.boolean())`), so obsolete flags stay inert config.

## Add a flag

Declare the definition in the owning domain's `flag.ts` and call `registerFlagDefinition` at the module top level. There is no central catalog to edit.

`src/<domain>/flag.ts`:

```ts
import { type FlagDefinitionInput, registerFlagDefinition } from '#/flag';

export const myFeatureFlag: FlagDefinitionInput = {
  id: 'my_feature',
  title: 'My feature',
  description: '...',
  env: 'KIMI_CODE_EXPERIMENTAL_MY_FEATURE',
  default: false,
  surface: 'both',
};

registerFlagDefinition(myFeatureFlag);
```

Then ensure the package entry `src/index.ts` imports the flag leaf precisely so the top-level call runs at import time — there is no `src/<domain>/index.ts` barrel:

```ts
// src/index.ts
import './<domain>/flag';
```

`src/index.ts` imports every domain's leaf files precisely (one line per leaf), so the contribution runs during bootstrap, before any scope is created — and therefore before any consumer resolves `IFlagService`.

- `env` must start with `KIMI_CODE_EXPERIMENTAL_`, be unique, and not equal `KIMI_CODE_EXPERIMENTAL_FLAG`.
- `id` must not be `flag`. A duplicate `id` throws when `FlagRegistryService` drains the contributions.
- `FlagId` is `string`, not a literal union: with no central catalog there is nothing to derive it from, so `enabled()` has no compile-time typo-checking. Cover gated behavior with tests instead.
- `surface`: `core` | `tui` | `both` (documentation/grouping only; not used in resolution).

## Consume a flag

Inject `IFlagService` and gate on it. It is resolvable from any scope (App ancestor):

```ts
constructor(@IFlagService private readonly flags: IFlagService) {}
// ...
if (!this.flags.enabled('my_feature')) return;
```

## Layering & scope

- Domain `flag` is registered at **L3**. It imports only `config` (L2) downward.
- It cannot live in `_base` (L0): registering/reading the config section requires importing `config`, and L0 must not import L2.
- Scope: `IFlagRegistry` and `IFlagService` are both `App`. Env + config are process-global inputs, so there is no per-session/agent state. Flag definitions are contributed at **import time** (top-level `registerFlagDefinition` calls), so they are queued before any scope is created and drained when `FlagRegistryService` is first instantiated — before `IFlagService` is first resolved.
- Tests build `FlagService` + `FlagRegistryService` directly with a real `ConfigRegistry`/`ConfigService` and an injected env map, then `register` the flags they exercise.

## Red lines (this topic)

- Gate unreleased behavior behind a registered flag; no ad-hoc env toggles.
- Contribute each flag from the **owning domain's** `flag.ts` (`src/<domain>/flag.ts`) via a top-level `registerFlagDefinition` call; there is no central catalog to edit. The directory names the domain, so the file is just `flag.ts`.
- `env` must start with `KIMI_CODE_EXPERIMENTAL_`, be unique, and not equal `KIMI_CODE_EXPERIMENTAL_FLAG`; `id` must not be `flag`.
- `FlagId` is `string` (decentralized registration) — do not reintroduce a central `FLAG_DEFINITIONS` array or a derived literal union.
- `flag` lives at L3 and `App` scope — never in `_base`, never per-session.
