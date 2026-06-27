/**
 * `hostFolderBrowser` domain (L1) — host-side folder picker.
 *
 * Defines the `IHostFolderBrowser` used by the program side (TUI / server) to
 * let the user browse the real local filesystem when choosing a workspace
 * folder. Distinct from the Agent-side `agentFs`, which is sandboxed and may
 * be remote. Core-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { HostDirEntry } from '#/hostFs';

export interface FsBrowseResponse {
  readonly path: string;
  readonly entries: readonly HostDirEntry[];
}

export interface IHostFolderBrowser {
  readonly _serviceBrand: undefined;

  browse(absPath?: string): Promise<FsBrowseResponse>;
  home(): Promise<string>;
}

export const IHostFolderBrowser: ServiceIdentifier<IHostFolderBrowser> =
  createDecorator<IHostFolderBrowser>('hostFolderBrowser');
