/**
 * `workspaceTrust` domain — per-workspace trust-state contract.
 *
 * Defines `IWorkspaceTrust`, the Workspace-scope owner of one yes/no fact:
 * has the user trusted this workspace. Trust gates everything the
 * workspace's own files may ask the engine to run before those files are
 * read as instructions — for example the project-level MCP config files
 * (project-root `.mcp.json` and `.kimi-code/mcp.json`) are skipped while
 * the workspace is untrusted, so a freshly cloned repo cannot auto-start
 * MCP servers. The marker is recorded OUTSIDE the workspace so a malicious
 * checkout cannot mark itself trusted, and every handler of the same root
 * resolves to the same record. Trust flips only through the explicit
 * `trust()` / `untrust()` calls — the engine has no interactive prompt.
 * Workspace-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export interface WorkspaceTrustChange {
  readonly trusted: boolean;
}

export interface IWorkspaceTrust {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  get(): Promise<boolean>;

  isTrusted(): boolean;

  trust(): Promise<void>;
  untrust(): Promise<void>;

  readonly onDidChange: Event<WorkspaceTrustChange>;
}

export const IWorkspaceTrust: ServiceIdentifier<IWorkspaceTrust> =
  createDecorator<IWorkspaceTrust>('workspaceTrust');
