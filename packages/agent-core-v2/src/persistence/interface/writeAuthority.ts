/**
 * `persistence/interface` — session-scoped write fencing contract.
 *
 * Defines `ISessionWriteAuthority`, the per-session lease proof that a Store
 * write must re-verify immediately before its bytes hit storage (the
 * pre-commit lease re-read is the hard gate and must fail closed), and the App-scoped
 * `IWriteAuthorityRegistry` the `AppendLogStore` resolves authorities through.
 * The registry never creates semantics of its own: it only maps `sessionId`
 * to the authority the session lifecycle registered, so a write for a
 * session with no registered authority is a bypass attempt and must be
 * rejected. `sessionIdFromScope` keeps the filesystem-layout knowledge
 * (`sessions/<wsId>/<sessionId>[/agents/<agentId>]`) in exactly one place;
 * the root scope (`''`, e.g. `session_index.jsonl`) and any scope outside
 * the sessions tree deliberately carry no authority and pass untouched.
 * The concrete registry lives in
 * `persistence/backends/node-fs/writeAuthorityRegistryService.ts`.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

export interface ISessionWriteAuthority {
  readonly sessionId: string;
  /** Re-reads the lease payload and compares the held lock token. Throws
      `Error2(session.lease_lost)` when this instance no longer holds the
      lease; must be called immediately before any durable write. */
  assertWritable(): void;
}

export const IWriteAuthorityRegistry: ServiceIdentifier<IWriteAuthorityRegistry> =
  createDecorator<IWriteAuthorityRegistry>('writeAuthorityRegistry');

export interface IWriteAuthorityRegistry {
  readonly _serviceBrand: undefined;

  /** Registers the session's authority. Throws when one is already
      registered for the sessionId — double registration is a bug, never a
      takeover. Dispose the returned handle to unregister. */
  register(authority: ISessionWriteAuthority): IDisposable;
  resolve(sessionId: string): ISessionWriteAuthority | undefined;
}

export function sessionIdFromScope(scope: string): string | undefined {
  if (scope === '') return undefined;
  const parts = scope.split('/');
  if (parts.length < 3 || parts[0] !== 'sessions') return undefined;
  const sessionId = parts[2];
  return parts[1] === '' || sessionId === undefined || sessionId === '' ? undefined : sessionId;
}
