import { createDecorator } from '../../di';

import type {
  FsBrowseResponse,
  FsHomeResponse,
  Workspace,
} from '@moonshot-ai/protocol';

import type { WorkspacePatch } from './workspaceRegistry';

/**
 * Unified facade over the workspace domain.
 *
 * `IWorkspaceService` is the single entry point that absorbs the workspace
 * **registry** + **root resolution** + **recent** + **browse** surfaces that
 * were previously split across {@link IWorkspaceRegistry} and
 * {@link IWorkspaceFsService}. It is a pure facade: every method delegates to
 * one of those underlying services — no workspace logic is duplicated here.
 *
 * The legacy {@link IWorkspaceRegistry} and {@link IWorkspaceFsService}
 * contracts (and their implementations) remain in place for existing
 * consumers; consolidating / removing those call sites is a later step. New
 * code SHOULD depend on `IWorkspaceService` instead.
 */
export interface IWorkspaceService {
  readonly _serviceBrand: undefined;

  // ── registry (mirrors IWorkspaceRegistry) ──────────────────────────────

  /** List every registered workspace (recency-ordered, newest first). */
  list(): Promise<Workspace[]>;

  /** Look up a single workspace by id. Throws if unknown. */
  get(workspaceId: string): Promise<Workspace>;

  /** Register `root` (idempotent — touching updates `last_opened_at`). */
  createOrTouch(root: string, name?: string): Promise<Workspace>;

  /** Patch mutable fields (currently the display `name`). */
  update(workspaceId: string, patch: WorkspacePatch): Promise<Workspace>;

  /** Unregister a workspace (does not remove on-disk content). */
  delete(workspaceId: string): Promise<void>;

  // ── root resolution ────────────────────────────────────────────────────

  /** Resolve a `workspace_id` to its absolute working directory (root). */
  resolveRoot(workspaceId: string): Promise<string>;

  // ── recent ─────────────────────────────────────────────────────────────

  /**
   * Recent workspaces, ordered by `last_opened_at` descending and capped at
   * `RECENT_ROOTS_LIMIT`.
   *
   * This is a derived view over the registry's existing recency ordering —
   * there is NO separate recents persistence. The same source backs
   * `IWorkspaceFsService.home().recent_roots` (which exposes the roots of
   * this exact set).
   */
  listRecent(): Promise<Workspace[]>;

  // ── browse (mirrors IWorkspaceFsService) ───────────────────────────────

  /** Browse a directory (defaults to the user's home when `absPath` omitted). */
  browse(absPath?: string): Promise<FsBrowseResponse>;

  /** Home directory + recent roots (derived from the registry). */
  home(): Promise<FsHomeResponse>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IWorkspaceService = createDecorator<IWorkspaceService>('workspaceService');
