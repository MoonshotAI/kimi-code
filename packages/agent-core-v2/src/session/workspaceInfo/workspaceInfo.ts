/**
 * `workspaceInfo` domain — seeded workspace-directory data contract.
 *
 * Defines `ISessionWorkspaceInfo`, the pure-data injection contract for the
 * workspace's additional directory set: a live read view plus its change
 * event. The contract carries no IO — persistence, caller-dir merging and
 * file watching all live on the workspace side. Seeded into the Session
 * scope when the session is materialized. Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { Event } from '#/_base/event';

export interface ISessionWorkspaceInfo {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly additionalDirs: readonly string[];
  readonly onDidChange: Event<void>;
}

export const ISessionWorkspaceInfo: ServiceIdentifier<ISessionWorkspaceInfo> =
  createDecorator<ISessionWorkspaceInfo>('sessionWorkspaceInfo');

export function sessionWorkspaceInfoSeed(info: ISessionWorkspaceInfo): ScopeSeed {
  return [[ISessionWorkspaceInfo as ServiceIdentifier<unknown>, info]];
}
