/**
 * `session` domain (L6) — session-warning contract.
 *
 * Produces the session-level warnings surfaced through the `getSessionWarnings`
 * RPC (e.g. the `agents-md-oversized` warning). Backed by {@link ISessionWarningService}.
 */

import type { SessionWarning } from '@moonshot-ai/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type { SessionWarning };

export interface ISessionWarningService {
  readonly _serviceBrand: undefined;

  /**
   * Compute the current session-level warnings. Recomputes the AGENTS.md size
   * warning on demand (preferring the main agent's cached value when the agent
   * is live) so the warning surfaces even for long-lived / resumed sessions.
   */
  getSessionWarnings(): Promise<readonly SessionWarning[]>;
}

export const ISessionWarningService: ServiceIdentifier<ISessionWarningService> =
  createDecorator<ISessionWarningService>('sessionWarningService');
