/**
 * Shared types for the rust transport — the `KlientChannel` implementation
 * that drives the Rust engine (`@moonshot-ai/kimi-agent/rust-loop`) instead
 * of the retired agent-core-v2 DI dispatcher.
 *
 * Service implementations (one module per service group under
 * `./services/`) receive a `RustCallContext` and resolve to rust-loop RPCs
 * (engine-backed services) or to the host-side bag (config / flags / auth /
 * fs / workspaces / plugins / catalog — assembled by `createKlientFromRust`
 * from node-sdk's exported host layer + `@moonshot-ai/kimi-code-oauth`).
 */

import type { ScopeRef } from '../../core/channel.js';
import type * as RustLoop from '@moonshot-ai/kimi-agent/rust-loop';

/** Host-side services the rust transport assembles (keys documented below).
 *  Loose bag by design: each service group reads its own key and the entry
 *  point builds the objects — keeps parallel service groups conflict-free. */
export interface RustHostServices {
  homeDir: string;
  configPath: string;
  /** G1 — config read/write + diagnostics (node-sdk legacy/config exports). */
  config?: unknown;
  /** G4 — experimental feature flags (port of node-sdk legacy/flags). */
  flags?: unknown;
  /** G3 — KimiAuthFacade / oauth toolkit surface. */
  auth?: unknown;
  /** G5 — host folder browser (fs browse/home). */
  fs?: unknown;
  /** G5 — workspace registry. */
  workspaces?: unknown;
  /** G5 — plugin read surface (list/getInfo/commands). */
  plugins?: unknown;
  /** G4 — model/provider catalog (kosong + models.dev). */
  catalog?: unknown;
}

export interface RustCallContext {
  /** Scope coordinates of the call (empty = core scope). */
  readonly scope: ScopeRef;
  /** Raw wire arguments (already contract-validated by the facade). */
  readonly args: unknown[];
  /** The rust-loop bridge (engine-backed services call its wrappers). */
  readonly rust: typeof RustLoop;
  /** Host-side services bag assembled by `createKlientFromRust`. */
  readonly host: RustHostServices;
}

/** One service method implementation. */
export type RustServiceMethod = (ctx: RustCallContext) => Promise<unknown>;
/** A service's method table. */
export type RustServiceRegistry = Record<string, RustServiceMethod>;

export { RPCError } from '../../core/errors.js';
