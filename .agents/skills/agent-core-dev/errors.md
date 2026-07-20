# Topic — Errors

Error infrastructure for agent-core-v2: base classes, the per-domain code contract, wire serialization, and the conventions domains follow when raising errors. The package-level reference is `packages/agent-core-v2/docs/errors.md`; this topic summarizes the hot-path rules.

Base classes and serialization are **centralized** in `_base/errors`; error **codes** are **decentralized** — each domain owns an `errors.ts` that self-registers its codes and metadata, and the `src/errors.ts` facade aggregates them into the unified `ErrorCodes` const.

## Where things live

- `src/_base/errors/errors.ts`: base classes — `Error2`, `ExpectedError`, `ErrorNoTelemetry`, `BugIndicatingError`, `NotImplementedError`, plus `isError2` and `unwrapErrorCause`.
- `src/_base/errors/codes.ts`: the `ErrorDomain` contract, the registry (`registerErrorDomain` / `errorInfo` / `isErrorCode`), and `CoreErrors` (`internal`, `not_implemented`). The `ErrorCode` union type is derived by `#/errors` from the aggregated domain definitions.
- `src/_base/errors/serialize.ts`: `ErrorPayload`, `isCodedError`, `toErrorPayload`, `fromErrorPayload`. Wire-facing names (`KimiErrorPayload`, `toKimiErrorPayload`) mirror the protocol and are kept as-is.
- `src/_base/errors/unexpectedError.ts`: `onUnexpectedError` / `setUnexpectedErrorHandler` (global handler).
- `src/<domain>/errors.ts`: the domain's `XxxErrors` descriptor (codes + retryable list + per-code info overrides), self-registered on import.
- `src/errors.ts`: the **facade** — imports every domain's `errors.ts`, builds `ErrorCodes`, re-exports the primitives. Throw sites import from here.

## Conventions (hard rules)

- **Throw a coded error, not a bare string.** `throw new Error2(ErrorCodes.X, …)`. Bare `new Error` only for unreachable guards; `BugIndicatingError` for caller bugs; `NotImplementedError('feature')` for stubs.
- **Define codes in the owning domain**, in `<domain>/errors.ts` as an `XxxErrors` descriptor (`satisfies ErrorDomain` + `registerErrorDomain`), then wire it into the facade. Never add domain codes to `_base/errors`.
- **One `code` per failure mode.** Codes read `domain.reason`. The valid code strings are derived from the aggregated domain definitions (`ErrorCode` in `#/errors` is computed from the `ErrorCodes` aggregate): **add new codes to the owning domain's `errors.ts`** — registration throws on cross-domain collisions. Renaming/removing a code is a major.
- **Translate foreign errors at the boundary.** Provider/HTTP, fs, MCP errors are re-thrown as the owning domain's coded error. `_base/errors` never imports a business domain.
- **Translation is idempotent and cause-preserving.** Translators (`toHostFsError`, `toStorageIoError`) pass through an already-translated error and always keep the original as `cause`.
- **`details` is structured and JSON-serializable; `message` is a short human sentence.** Paths/errnos/scope/key go into `details`, not the message.
- **Cancellation passes through untranslated** (`UserCancellationError` from `_base/utils/abort`) — apply only at boundaries that can actually see cancellation; do not sprinkle the check everywhere.
- **Classify wrapped errors via `unwrapErrorCause`** — errno/status predicates test the unwrapped cause, not the coded wrapper.
- **Branch on `code`, never `instanceof`, across the wire.** In-process, `instanceof Error2` / `isCodedError` are fine.

## Reference tiers

- `os.fs` — `HostFsError` via `toHostFsError` (`os/interface/hostFsErrors.ts`): errno → `os.fs.*`, details `{ path, op, errno?, syscall? }`.
- `os.process` — `HostProcessError`: `spawn_failed` / `kill_failed`, raw error as `cause`.
- `storage` — `StorageError` (`persistence/interface/storage.ts`): `not_found` / `decode_failed` / `corrupted` / `io_failed` (retryable) / `locked` (retryable). ENOENT keeps absence semantics, never an error. A locked query store throws `storage.locked`; consumers catch it explicitly and fall back — no silent no-op degradation.
- `wire` — `WireError` (`wire/errors.ts`): `DuplicateOpError`, `CycleError`, and `wire.unknown_record` (replay skips unknown records, reports via `onUnexpectedError`, returns `{ unknownRecords }`).

## Red lines (this topic)

- Throw a coded error with a `code`, not a bare string (except unreachable guards / `BugIndicatingError` / `NotImplementedError`).
- Codes live in the owning domain's `errors.ts` and self-register; new codes land in the owning domain first.
- Translate foreign errors at the owning domain's boundary, idempotently, with `cause` and structured `details`; `_base/errors` never imports a business domain.
- Branch on `code` across the wire, never `instanceof`.
