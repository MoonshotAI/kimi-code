/**
 * `password` domain (L7) — session-scope password request broker.
 *
 * Defines the public contract of asking the user for a password: the
 * `PasswordRequest` / `PasswordResponse` models and the
 * `ISessionPasswordService` used to request a password, resolve it, and list
 * pending requests. The primary producer is the sudo-askpass channel (see
 * `session/sudoAskpass`); the consumer answering the request is a connected
 * client at the edge. SECURITY: the submitted password exists only in the
 * in-memory resolution — the interaction kernel journals a redacted
 * `{cancelled}` response for this kind, and the edge never echoes the
 * password back onto the wire. Session-scoped — one broker per session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface PasswordRequest {
  readonly id?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  /** The prompt the askpass helper received from sudo (e.g. `[sudo] password for user: `). */
  readonly prompt: string;
  /** The command that triggered the sudo prompt (truncated by the producer). */
  readonly command?: string;
}

/**
 * In-memory resolution. `password` is present only when `cancelled` is false;
 * it must never be journaled, logged, broadcast, or fed back to the model.
 */
export interface PasswordResponse {
  readonly cancelled: boolean;
  readonly password?: string;
}

export interface ISessionPasswordService {
  readonly _serviceBrand: undefined;

  request(req: PasswordRequest): Promise<PasswordResponse>;
  enqueue(req: PasswordRequest): PasswordRequest & { readonly id: string };
  resolve(id: string, response: PasswordResponse): void;
  listPending(): readonly PasswordRequest[];
}

export const ISessionPasswordService: ServiceIdentifier<ISessionPasswordService> =
  createDecorator<ISessionPasswordService>('sessionPasswordService');
