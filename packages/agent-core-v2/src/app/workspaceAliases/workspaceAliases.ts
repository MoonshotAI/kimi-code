/**
 * `workspaceAliases` domain — workspace id-spelling resolution contract.
 *
 * Defines the App-scoped `IWorkspaceAliases`: the read-side counterpart to the
 * workspace write-path folding. One physical folder may be addressable by
 * several id spellings (legacy split buckets); this service enumerates them so
 * readers can query every sibling session bucket at once. App-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IWorkspaceAliases {
  readonly _serviceBrand: undefined;

  resolveAliasIds(id: string): Promise<readonly string[]>;
}

export const IWorkspaceAliases: ServiceIdentifier<IWorkspaceAliases> =
  createDecorator<IWorkspaceAliases>('workspaceAliases');
