# errors

> Error infrastructure for agent-core-v2: base classes, the public code registry, wire serialization, and the conventions domains follow when raising errors.

Design is borrowed from VSCode (`src/vs/base/common/errors.ts` + per-service error classes) with one addition: a central **code registry** for the RPC/SDK boundary. Mechanism is centralized in `_base/errors`; error *classes* are decentralized (co-located per domain); error *codes* are decentralized too but aggregated into one registry with metadata.

## Where things live

- `src/_base/errors/errors.ts`: base classes — `KimiError`, `CancellationError`, `ExpectedError`, `ErrorNoTelemetry`, `BugIndicatingError`, `NotImplementedError`.
- `src/_base/errors/codes.ts`: `ErrorCodes` registry, `ErrorCode` type, `ERROR_INFO` metadata (`title` / `retryable` / `public` / `action`), `errorInfo(code)`.
- `src/_base/errors/serialize.ts`: `ErrorPayload`, `isCodedError`, `toErrorPayload`, `fromErrorPayload`, `makeErrorPayload`.
- `src/_base/errors/errorMessage.ts`: `toErrorMessage(error, verbose?)` for logs/CLI.
- `src/_base/errors/unexpectedError.ts`: `onUnexpectedError` / `setUnexpectedErrorHandler` / `safelyCallListener` (global handler).
- `src/_base/di/errors.ts`: DI-only `CyclicDependencyError` (kept separate; the DI layer exposes no general error taxonomy, like VSCode).

## Conventions (hard rules)

- **Throw a coded error, not a bare string.** Define a domain error that `extends KimiError` and carries a `code`. `throw new Error('x')` only for unreachable guards; use `NotImplementedError('feature')` for stubs.
- **Co-locate the error class with the domain's interfaces.** `ToolError` lives in `tool/tool.ts` next to `IToolService`, not in a separate `*Errors.ts` and not in `_base/errors`.
- **One `code` per failure mode.** Codes read `domain.reason` (e.g. `tool.unknown_tool`). Adding a code is minor; renaming/removing one is a major (breaks SDK clients).
- **Register codes centrally.** After defining a domain's `XxxErrorCode` const, spread it into `ErrorCodes` in `codes.ts` and add an `ERROR_INFO` entry per code.
- **Translate foreign errors at the boundary.** Provider/HTTP, fs, MCP errors are caught at the domain boundary and re-thrown as the domain's coded error. `_base/errors` never imports a business domain.
- **Branch on `code`, never `instanceof`, across the wire.** Class identity does not survive serialization. In-process, `instanceof KimiError` / `isCodedError` are fine.

## Adding a domain error (recipe)

In `<domain>/<domain>.ts`:

```ts
import { KimiError, type ErrorCode } from '#/_base/errors';

export const ToolErrorCode = {
  UnknownTool: 'tool.unknown_tool',
  ExecutionFailed: 'tool.execution_failed',
} as const;
export type ToolErrorCode = (typeof ToolErrorCode)[keyof typeof ToolErrorCode];

export class ToolError extends KimiError {
  constructor(code: ToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(code as ErrorCode, message, { details });
    this.name = 'ToolError';
  }
}
```

Then in `src/_base/errors/codes.ts`, spread `...ToolErrorCode` into `ErrorCodes` and add an `ERROR_INFO` entry for `tool.unknown_tool` and `tool.execution_failed`.

## Serialization & boundary translation

- `toErrorPayload(error)`: `CancellationError` → `canceled`; any coded error (incl. deserialized shapes) → its code + `retryable` from `ERROR_INFO`; anything else → `internal`.
- `fromErrorPayload(payload)`: rehydrates a `KimiError` for in-process `instanceof` / `isCodedError` use at the SDK/RPC boundary.
- `isCodedError(error)`: structural guard (checks `code` against `ERROR_INFO`), so it works for both `KimiError` instances and plain objects revived from a payload.
- Foreign-error mapping lives in the domain that owns the foreign dependency, e.g. kosong maps `APIStatusError` (429/401/…) → `KosongError` codes at its client boundary. A `registerErrorNormalizer` escape hatch is intentionally **not** provided until a second use case appears.

## Deliberately omitted

- No `IErrorWithActions` / action buttons — there is no notification surface in agent-core; add when one exists.
- No class registry / revival — payloads carry `code` + data only; rehydration always yields a base `KimiError`.
- No `IllegalArgumentError` / `NotSupportedError` yet — add a base class when a second throw site needs it.

## References

- `packages/agent-core-v2/src/_base/errors/` — implementation.
- `packages/agent-core/src/errors/` — v1 source this was ported from.
- `packages/agent-core-v2/GAP_ANALYSIS.md` §2.2 — gap closure note (`_base/errors`).
- `packages/agent-core-v2/GAP_ANALYSIS.md` §2.6 — RPC/SDK boundary that motivates the code registry.
- VSCode upstream: `src/vs/base/common/errors.ts`, `src/vs/base/common/errorMessage.ts`, `src/vs/platform/files/common/files.ts` (`FileOperationError` + `FileOperationResult`), `src/vs/platform/userDataSync/common/userDataSync.ts` (`UserDataSyncError` + code enum + normalizer).
