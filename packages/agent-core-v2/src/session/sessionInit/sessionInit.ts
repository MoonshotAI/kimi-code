/**
 * `sessionInit` domain — `/init` command contract.
 *
 * Drives the `/init` slash command: spawn a `coder` subagent that analyzes the
 * codebase and writes `AGENTS.md`, then surface the freshly generated content
 * back into the main agent as an `init`-variant system reminder. Bound at
 * Session scope — the operation is one session-level action that reaches the
 * session's main agent.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionInitService {
  readonly _serviceBrand: undefined;

  generateAgentsMd(): Promise<void>;

  cancelInit(): void;
}

export const ISessionInitService: ServiceIdentifier<ISessionInitService> =
  createDecorator<ISessionInitService>('sessionInitService');
