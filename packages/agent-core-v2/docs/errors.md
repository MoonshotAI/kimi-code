# errors

> Error infrastructure for agent-core-v2: base classes, the per-domain code
> contract, the public `ErrorCodes` facade, wire serialization, and the
> conventions domains follow when raising errors.

Base classes and serialization are centralized in `_base/errors`; error **codes**
are **decentralized** — each domain owns an `errors.ts` that contributes its
codes and metadata, and the `src/errors.ts` facade aggregates them into the
unified `ErrorCodes` const.

## Where things live

- `src/_base/errors/errors.ts`: base classes — `Error2`, `ExpectedError`, `ErrorNoTelemetry`, `BugIndicatingError`, `NotImplementedError`, plus the `isError2` guard and `unwrapErrorCause`.
- `src/_base/errors/codes.ts`: the `ErrorDomain` contract, the `ErrorCode` type (aliased to the protocol's `KimiErrorCode`), the runtime registry (`registerErrorDomain` / `errorInfo` / `isErrorCode`), and the domain-independent `CoreErrors` (`internal`, `not_implemented`).
- `src/_base/errors/serialize.ts`: `ErrorPayload`, `isCodedError`, `toErrorPayload`, `fromErrorPayload`, `makeErrorPayload`. Reads retryability from the registry via `errorInfo`. The wire-facing names (`KimiErrorPayload`, `toKimiErrorPayload`) mirror the protocol contract and keep their names even though the in-process class is `Error2`.
- `src/_base/errors/errorMessage.ts`: `toErrorMessage(error, verbose?)` for logs/CLI.
- `src/_base/errors/unexpectedError.ts`: `onUnexpectedError` / `setUnexpectedErrorHandler` / `safelyCallListener`.
- `src/<domain>/errors.ts`: each domain's `XxxErrors` descriptor (codes + retryable list + per-code info overrides), self-registered on import.
- `src/errors.ts`: the **facade** — imports every domain's `errors.ts` (triggering registration), builds the unified `ErrorCodes` const, and re-exports all error primitives. This is the import throw sites use.

## Conventions (hard rules)

- **Throw a coded error, not a bare string.** `throw new Error2(ErrorCodes.X, …)`. `throw new Error('x')` only for unreachable guards; `BugIndicatingError` when the throw site indicates a caller bug (e.g. reading a service before its `ready`); `NotImplementedError('feature')` for stubs.
- **Define codes in the owning domain.** A domain's codes live in `<domain>/errors.ts` next to its interfaces, exported as an `XxxErrors` descriptor — never in `_base/errors`.
- **One `code` per failure mode.** Codes read `domain.reason` (e.g. `tool.unknown_tool`). The set of valid code strings is fixed by the protocol (`KimiErrorCode`); adding a brand-new code means updating the protocol first. Renaming/removing a code is a major (breaks SDK clients).
- **Import from the facade.** Throw sites and cross-domain consumers do `import { ErrorCodes, Error2 } from '#/errors'`. A domain's own `errors.ts` references its own descriptor (`LoopErrors.codes.X`) and imports only from `#/_base/errors` (never from `#/errors`, to avoid cycles).
- **Translate foreign errors at the boundary.** Provider/HTTP, fs, MCP errors are caught at the domain boundary and re-thrown as the domain's coded error. `_base/errors` never imports a business domain.
- **Translation is idempotent.** A translator (`toHostFsError`, `toStorageIoError`, …) returns its input unchanged when it is already the domain's error type, so layered boundaries never double-wrap. The original error always goes to `cause`.
- **`details` is structured and JSON-serializable; `message` is a short human sentence.** Paths, errnos, syscalls, scope/key, line numbers go into `details`; the message must stay readable without them.
- **Cancellation passes through untranslated.** A translation boundary that can see a cancellation-class error (`UserCancellationError` from `_base/utils/abort`) rethrows it as-is. fs/process translation never encounters cancellation, so those translators do not check for it — apply the rule only at boundaries that actually can.
- **Classify wrapped foreign errors via `unwrapErrorCause`.** Predicates that branch on raw shapes (errno, provider status) test `unwrapErrorCause(error)`, since boundary-translated errors carry the raw error as `cause`.
- **Branch on `code`, never `instanceof`, across the wire.** Class identity does not survive serialization. In-process, `instanceof Error2` / `isCodedError` are fine.

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

## Domain tiers in practice

The os / persistence / wire domains show the standard shapes:

- **`os.fs` (`HostFsError`, `os/interface/hostFsErrors.ts`)** — every `IHostFileSystem` backend translates raw errnos at its boundary via the pure `toHostFsError(err, { path, op })`: `ENOENT→os.fs.not_found`, `EISDIR→os.fs.is_directory`, `ENOTDIR→os.fs.not_directory`, `EEXIST→os.fs.already_exists`, `EACCES/EPERM→os.fs.permission_denied`, `ENOTEMPTY→os.fs.not_empty`, everything else `os.fs.unknown`. `details` carries `{ path, op, errno?, syscall? }`. Documented boolean semantics (e.g. `createExclusive` returning `false` on `EEXIST`) stay booleans, not errors.
- **`os.process` (`HostProcessError`, `os/interface/hostProcess.ts`)** — `os.process.spawn_failed` (details `{ command, args?, cwd?, errno? }`) and `os.process.kill_failed`; both carry the raw error as `cause`. Kill keeps its deliberate tolerances: `ESRCH` is a silent no-op, `EPERM` degrades to `child.kill()`.
- **`storage` (`StorageError`, `persistence/interface/storage.ts`)** — `storage.not_found` / `decode_failed` / `corrupted` / `io_failed` / `locked`. ENOENT keeps its established absence semantics (`read → undefined`, `list → []`) and is *not* an error; other I/O failures become `storage.io_failed` (`retryable`). Codec parse failures become `storage.decode_failed` with `{ scope, key, format }`; append-log corruption is `AppendLogCorruptedError` (`storage.corrupted`). A query-store open failure (writer lock held by another process) throws `storage.locked` — consumers (e.g. `FileSessionIndex`) catch it explicitly and fall back to their non-read-model path with a one-time warning; there is no silent no-op degradation.
- **`wire` (`WireError`, `wire/errors.ts`)** — `DuplicateOpError` (`wire.duplicate_op`, a build-time bug), `CycleError` (`wire.cycle`, details carry the drain depth and a capped op-type sample), and `wire.unknown_record`: replay skips records whose Op type is absent from `OP_REGISTRY` (compatibility), reports each skip through `onUnexpectedError`, and returns `{ unknownRecords }` so the caller knows the restore was lossy.

## Serialization & boundary translation

- `toErrorPayload(error)`: any coded error (incl. deserialized shapes) → its code + `retryable` from `errorInfo`; anything else → `internal`.
- `fromErrorPayload(payload)`: rehydrates an `Error2` for in-process `instanceof` / `isCodedError` use at the SDK/RPC boundary.
- `isCodedError(error)`: structural guard (checks `code` against the registry), so it works for both `Error2` instances and plain objects revived from a payload.
- The registry is populated when the facade is imported (the package `index.ts` re-exports it); tests that import a single domain get that domain's codes via its self-registration. `errorInfo` falls back to `{ title: code, retryable, public: true }` for any unregistered code.

## References

- `packages/agent-core-v2/src/_base/errors/` — contract, registry, base classes, serialization.
- `packages/agent-core-v2/src/errors.ts` — the aggregating facade.
- `packages/protocol/src/events.ts` — the canonical `KimiErrorCode` wire union.
