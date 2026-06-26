# errors

> Error infrastructure for agent-core-v2: base classes, the per-domain code
> contract, the public `ErrorCodes` facade, wire serialization, and the
> conventions domains follow when raising errors.

Base classes and serialization are centralized in `_base/errors`; error **codes**
are **decentralized** — each domain owns an `errors.ts` that contributes its
codes and metadata, and the `src/errors.ts` facade aggregates them into the
unified `ErrorCodes` const.

## Where things live

- `src/_base/errors/errors.ts`: base classes — `KimiError`, `CancellationError`, `ExpectedError`, `ErrorNoTelemetry`, `BugIndicatingError`, `NotImplementedError`.
- `src/_base/errors/codes.ts`: the `ErrorDomain` contract, the `ErrorCode` type (aliased to the protocol's `KimiErrorCode`), the runtime registry (`registerErrorDomain` / `errorInfo` / `isErrorCode`), and the domain-independent `CoreErrors` (`internal`, `not_implemented`).
- `src/_base/errors/serialize.ts`: `ErrorPayload`, `isCodedError`, `toErrorPayload`, `fromErrorPayload`, `makeErrorPayload`. Reads retryability from the registry via `errorInfo`.
- `src/_base/errors/errorMessage.ts`: `toErrorMessage(error, verbose?)` for logs/CLI.
- `src/_base/errors/unexpectedError.ts`: `onUnexpectedError` / `setUnexpectedErrorHandler` / `safelyCallListener`.
- `src/<domain>/errors.ts`: each domain's `XxxErrors` descriptor (codes + retryable list + per-code info overrides), self-registered on import.
- `src/errors.ts`: the **facade** — imports every domain's `errors.ts` (triggering registration), builds the unified `ErrorCodes` const, and re-exports all error primitives. This is the import throw sites use.

## Conventions (hard rules)

- **Throw a coded error, not a bare string.** `throw new KimiError(ErrorCodes.X, …)`. `throw new Error('x')` only for unreachable guards; `NotImplementedError('feature')` for stubs.
- **Define codes in the owning domain.** A domain's codes live in `<domain>/errors.ts` next to its interfaces, exported as an `XxxErrors` descriptor — never in `_base/errors`.
- **One `code` per failure mode.** Codes read `domain.reason` (e.g. `tool.unknown_tool`). The set of valid code strings is fixed by the protocol (`KimiErrorCode`); adding a brand-new code means updating the protocol first. Renaming/removing a code is a major (breaks SDK clients).
- **Import from the facade.** Throw sites and cross-domain consumers do `import { ErrorCodes, KimiError } from '#/errors'`. A domain's own `errors.ts` references its own descriptor (`LoopErrors.codes.X`) and imports only from `#/_base/errors` (never from `#/errors`, to avoid cycles).
- **Translate foreign errors at the boundary.** Provider/HTTP, fs, MCP errors are caught at the domain boundary and re-thrown as the domain's coded error. `_base/errors` never imports a business domain.
- **Branch on `code`, never `instanceof`, across the wire.** Class identity does not survive serialization. In-process, `instanceof KimiError` / `isCodedError` are fine.

## Adding a domain error (recipe)

In `<domain>/errors.ts`:

```ts
import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const ToolErrors = {
  codes: {
    UNKNOWN_TOOL: 'tool.unknown_tool',
    EXECUTION_FAILED: 'tool.execution_failed',
  },
  retryable: ['tool.execution_failed'],
  info: {
    'tool.unknown_tool': {
      title: 'Unknown tool',
      retryable: false,
      public: true,
      action: 'Check the tool name passed by the model.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ToolErrors);
```

Then wire it into the facade in `src/errors.ts`: import `ToolErrors`, add
`...ToolErrors.codes` to the `ErrorCodes` spread, and re-export it. The
`satisfies ErrorDomain` guarantees every code value is a protocol-known
`ErrorCode`, and `registerErrorDomain` makes its metadata available to
serialization.

## Serialization & boundary translation

- `toErrorPayload(error)`: `CancellationError` → `internal`; any coded error (incl. deserialized shapes) → its code + `retryable` from `errorInfo`; anything else → `internal`.
- `fromErrorPayload(payload)`: rehydrates a `KimiError` for in-process `instanceof` / `isCodedError` use at the SDK/RPC boundary.
- `isCodedError(error)`: structural guard (checks `code` against the registry), so it works for both `KimiError` instances and plain objects revived from a payload.
- The registry is populated when the facade is imported (the package `index.ts` re-exports it); tests that import a single domain get that domain's codes via its self-registration. `errorInfo` falls back to `{ title: code, retryable, public: true }` for any unregistered code.

## References

- `packages/agent-core-v2/src/_base/errors/` — contract, registry, base classes, serialization.
- `packages/agent-core-v2/src/errors.ts` — the aggregating facade.
- `packages/protocol/src/events.ts` — the canonical `KimiErrorCode` wire union.
