/**
 * `hostFolderBrowser` domain (L2) — host-side folder picker.
 *
 * Defines the `IHostFolderBrowser` used by the program side (TUI / server) to
 * let the user browse the real local filesystem when choosing a workspace
 * folder. Distinct from the Session-side `sessionFs`, which is sandboxed and may
 * be remote. App-scoped.
 *
 * The wire shapes (`FsBrowseResponse` / `FsHomeResponse`) are defined here as
 * zod schemas so the `/api/v1` and `/api/v2` transports share one contract.
 * Domain errors (`HostFolder*Error`) carry the failing path and are
 * translated to wire error codes at the transport boundary.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const fsBrowseQuerySchema = z.object({
  path: z.string().min(1).optional(),
});
export type FsBrowseQuery = z.infer<typeof fsBrowseQuerySchema>;

export const fsBrowseEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  is_dir: z.literal(true),
  is_git_repo: z.boolean(),
  branch: z.string().optional(),
});
export type FsBrowseEntry = z.infer<typeof fsBrowseEntrySchema>;

export const fsBrowseResponseSchema = z.object({
  path: z.string().min(1),
  parent: z.string().min(1).nullable(),
  entries: z.array(fsBrowseEntrySchema),
});
export type FsBrowseResponse = z.infer<typeof fsBrowseResponseSchema>;

export const fsHomeResponseSchema = z.object({
  home: z.string().min(1),
  recent_roots: z.array(z.string().min(1)),
});
export type FsHomeResponse = z.infer<typeof fsHomeResponseSchema>;

export class HostFolderNotAbsoluteError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`path must be absolute: ${path}`);
    this.name = 'HostFolderNotAbsoluteError';
    this.path = path;
  }
}

export class HostFolderNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`path not found: ${path}`);
    this.name = 'HostFolderNotFoundError';
    this.path = path;
  }
}

export class HostFolderPermissionError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`permission denied: ${path}`);
    this.name = 'HostFolderPermissionError';
    this.path = path;
  }
}

export interface IHostFolderBrowser {
  readonly _serviceBrand: undefined;

  browse(absPath?: string): Promise<FsBrowseResponse>;
  home(): Promise<FsHomeResponse>;
}

export const IHostFolderBrowser: ServiceIdentifier<IHostFolderBrowser> =
  createDecorator<IHostFolderBrowser>('hostFolderBrowser');

export const RECENT_ROOTS_LIMIT = 8;
