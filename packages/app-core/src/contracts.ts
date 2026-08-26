// app-core contracts — small, dependency-free surfaces that the consumer
// application implements to plug its runtime into the api transport.
//
// The api layer (DaemonHttpClient / DaemonEventSocket / DaemonKimiWebApi) never
// imports a concrete tracer or credential store; both are injected via the
// constructor. The shapes below mirror the consumer's trace + credential
// surfaces so a thin, allocation-free wrapper can bridge them through.

import type { InjectionKey } from 'vue';
export interface ClientIdentity {
  readonly clientId: string;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly clientUiMode: string;
}

export interface RestRequestInfo {
  method: string;
  path: string;
  url: string;
  requestId: string;
  body?: unknown;
}

export interface RestResponseInfo {
  method: string;
  path: string;
  requestId: string;
  status: number;
  durationMs: number;
  code: number;
  msg: string;
  envelopeRequestId?: string;
  data?: unknown;
}

export interface RestFailureInfo {
  method: string;
  path: string;
  requestId: string;
  phase: 'fetch' | 'parse';
  durationMs: number;
  status?: number;
  error: unknown;
}

export type WsTraceEvent =
  | { kind: 'lifecycle'; event: string; detail?: unknown }
  | { kind: 'in'; frame: unknown }
  | { kind: 'out'; frame: unknown };

export interface Tracer {
  restRequest?(info: RestRequestInfo): void;
  restResponse?(info: RestResponseInfo): void;
  restFailure?(info: RestFailureInfo): void;
  wsEvent?(info: WsTraceEvent): void;
  /** Low-frequency product-path lifecycle event (e.g. `session:snapshot:start`). */
  traceKeyEvent?(event: string, info?: Record<string, unknown>): void;
}

export const noopTracer: Tracer = {};

/**
 * Translation function injected by the consumer (usually its vue-i18n global
 * `t`, wrapped). Package modules never import a concrete i18n instance; text
 * builders receive this as their first parameter.
 */
export type Translator = (key: string, params?: Record<string, unknown>) => string;

export interface CredentialStore {
  getToken(): string | undefined;
  markAuthRequired?(): void;
}

export interface ResolveImage {
  (src: string): Promise<string>;
}

/** Provide/inject key for the app-level markdown image resolver (auth-bearing
    blob fetch). Lives here — next to the ResolveImage contract — so
    app-markdown can inject without depending on a higher-layer package. */
export const ResolveImageKey: InjectionKey<ResolveImage> = Symbol('resolveImage');
