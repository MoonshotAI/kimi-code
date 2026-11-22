import { ref, watch } from 'vue';
import { defineStore } from 'pinia';

import type {
  AppGitBranch,
  AppWorktreeSetupRequest,
  WorkspaceGitBranches,
  WorktreeSetupScript,
} from '@moonshot-ai/app-core/api';
import {
  STORAGE_KEYS,
  buildWorktreeSetupRequest,
  canIncludeLocalChanges,
  effectiveNewSessionEnvironment,
  resolveWorktreeSource,
  safeGetJson,
  safeSetJson,
  type NewSessionEnvironment,
  type WorktreeAvailability,
  type WorktreeSourcePreference,
  type WorktreeSourceSelection,
} from '@moonshot-ai/app-core/lib';
import { getKimiWebApi } from '../client/deps';
import { clientPinia } from './pinia';
import { workspacesStore } from './workspaces';

export interface WorkspaceBranchesState {
  status: 'loading' | 'ready' | 'failed';
  info?: WorkspaceGitBranches;
}

export interface NewSessionEnvironmentView {
  preferred: NewSessionEnvironment;
  effective: NewSessionEnvironment;
  availability: WorktreeAvailability;
  headBranch?: string;
  branches: AppGitBranch[];
  remotes: string[];
  selection: WorktreeSourceSelection | null;
  canIncludeLocalChanges: boolean;
  remoteAvailable: boolean;
  useRemote: boolean;
  usesRemote: boolean;
  setupScript: WorktreeSetupScript | null;
  runSetupScript: boolean;
}

function loadRecord<T>(key: string, accept: (value: unknown) => T | undefined): Record<string, T> {
  const raw = safeGetJson<unknown>(key);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, T> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const accepted = accept(value);
    if (accepted !== undefined) out[id] = accepted;
  }
  return out;
}

function acceptSource(value: unknown): WorktreeSourcePreference | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = value as { branch?: unknown; includeLocalChanges?: unknown };
  if (typeof candidate.branch !== 'string' || candidate.branch.length === 0) return undefined;
  return candidate.includeLocalChanges === true
    ? { branch: candidate.branch, includeLocalChanges: true }
    : { branch: candidate.branch };
}

export const useNewSessionEnvironmentStore = defineStore('kimi.newSessionEnvironment', () => {
  const preferred = ref<NewSessionEnvironment>('local');
  const branchesByWorkspace = ref<Record<string, WorkspaceBranchesState>>({});
  const sourceByWorkspace = ref<Record<string, WorktreeSourcePreference>>(
    loadRecord(STORAGE_KEYS.worktreeSourceByWorkspace, acceptSource),
  );
  const useRemoteByWorkspace = ref<Record<string, boolean>>(
    loadRecord(STORAGE_KEYS.worktreeUseRemoteByWorkspace, (value) => (typeof value === 'boolean' ? value : undefined)),
  );
  const runSetupScript = ref(true);
  const setupScriptByWorkspace = ref<Record<string, WorktreeSetupScript>>({});
  const setupScriptErrorByWorkspace = ref<Record<string, string>>({});
  const requestSeqByWorkspace = new Map<string, number>();
  const inFlightByWorkspace = new Map<string, Promise<void>>();
  const scriptSeqByWorkspace = new Map<string, number>();
  const scriptInFlightByWorkspace = new Map<string, Promise<void>>();

  function workspaceOf(workspaceId: string) {
    return workspacesStore().mergedWorkspaces.find((workspace) => workspace.id === workspaceId);
  }

  function supportsWorktree(workspaceId: string): boolean {
    const workspace = workspaceOf(workspaceId);
    return workspace !== undefined && workspace.hostId === undefined;
  }

  function selectEnvironment(environment: NewSessionEnvironment): void {
    preferred.value = environment;
  }

  function loadBranches(workspaceId: string): Promise<void> {
    const seq = (requestSeqByWorkspace.get(workspaceId) ?? 0) + 1;
    requestSeqByWorkspace.set(workspaceId, seq);
    const previous = branchesByWorkspace.value[workspaceId];
    branchesByWorkspace.value = {
      ...branchesByWorkspace.value,
      [workspaceId]: { status: 'loading', info: previous?.info },
    };
    const isCurrent = (): boolean => requestSeqByWorkspace.get(workspaceId) === seq;
    const promise = (async () => {
      try {
        const info = await getKimiWebApi().getWorkspaceGitBranches(workspaceId);
        if (!isCurrent()) return;
        branchesByWorkspace.value = { ...branchesByWorkspace.value, [workspaceId]: { status: 'ready', info } };
      } catch {
        if (!isCurrent()) return;
        branchesByWorkspace.value = {
          ...branchesByWorkspace.value,
          [workspaceId]: { status: 'failed', info: previous?.info },
        };
      }
    })().finally(() => {
      if (inFlightByWorkspace.get(workspaceId) === promise) inFlightByWorkspace.delete(workspaceId);
    });
    inFlightByWorkspace.set(workspaceId, promise);
    return promise;
  }

  function ensureBranches(workspaceId: string | null | undefined): Promise<void> {
    if (workspaceId === null || workspaceId === undefined || !supportsWorktree(workspaceId)) return Promise.resolve();
    const inFlight = inFlightByWorkspace.get(workspaceId);
    if (inFlight !== undefined) return inFlight;
    if (branchesByWorkspace.value[workspaceId]?.status === 'ready') return Promise.resolve();
    return loadBranches(workspaceId);
  }

  function refreshBranches(workspaceId: string | null | undefined): Promise<void> {
    if (workspaceId === null || workspaceId === undefined || !supportsWorktree(workspaceId)) return Promise.resolve();
    return inFlightByWorkspace.get(workspaceId) ?? loadBranches(workspaceId);
  }

  function availability(workspaceId: string | null | undefined): WorktreeAvailability {
    if (workspaceId === null || workspaceId === undefined) return 'loading';
    const workspace = workspaceOf(workspaceId);
    if (workspace === undefined) return 'loading';
    if (workspace.hostId !== undefined) return 'remoteHost';
    const state = branchesByWorkspace.value[workspaceId];
    const info = state?.info;
    if (info !== undefined) {
      if (!info.isRepo) return 'notGitRepo';
      return resolveWorktreeSource(info) === null ? 'failed' : 'available';
    }
    return state?.status === 'failed' ? 'failed' : 'loading';
  }

  function effectiveEnvironment(workspaceId: string | null | undefined): NewSessionEnvironment {
    return effectiveNewSessionEnvironment(preferred.value, availability(workspaceId));
  }

  function selection(workspaceId: string | null | undefined): WorktreeSourceSelection | null {
    if (workspaceId === null || workspaceId === undefined) return null;
    return resolveWorktreeSource(branchesByWorkspace.value[workspaceId]?.info, sourceByWorkspace.value[workspaceId]);
  }

  function selectSource(workspaceId: string, source: WorktreeSourcePreference): boolean {
    const info = branchesByWorkspace.value[workspaceId]?.info;
    if (info === undefined || !info.branches.some((branch) => branch.name === source.branch)) return false;
    const includeLocalChanges = source.includeLocalChanges === true && canIncludeLocalChanges(info, source.branch);
    sourceByWorkspace.value = {
      ...sourceByWorkspace.value,
      [workspaceId]: includeLocalChanges ? { branch: source.branch, includeLocalChanges: true } : { branch: source.branch },
    };
    safeSetJson(STORAGE_KEYS.worktreeSourceByWorkspace, sourceByWorkspace.value);
    return true;
  }

  function useRemote(workspaceId: string | null | undefined): boolean {
    return workspaceId !== null && workspaceId !== undefined && useRemoteByWorkspace.value[workspaceId] === true;
  }

  function setUseRemote(workspaceId: string, value: boolean): void {
    useRemoteByWorkspace.value = { ...useRemoteByWorkspace.value, [workspaceId]: value };
    safeSetJson(STORAGE_KEYS.worktreeUseRemoteByWorkspace, useRemoteByWorkspace.value);
  }

  function setRunSetupScript(value: boolean | undefined): void {
    runSetupScript.value = value ?? true;
  }

  function setupScript(workspaceId: string | null | undefined): WorktreeSetupScript | null {
    if (workspaceId === null || workspaceId === undefined) return null;
    return setupScriptByWorkspace.value[workspaceId] ?? null;
  }

  function setupScriptError(workspaceId: string | null | undefined): string | null {
    if (workspaceId === null || workspaceId === undefined) return null;
    return setupScriptErrorByWorkspace.value[workspaceId] ?? null;
  }

  function nextScriptSeq(workspaceId: string): number {
    const seq = (scriptSeqByWorkspace.get(workspaceId) ?? 0) + 1;
    scriptSeqByWorkspace.set(workspaceId, seq);
    return seq;
  }

  function setSetupScriptError(workspaceId: string, message: string | null): void {
    const next = { ...setupScriptErrorByWorkspace.value };
    if (message === null) delete next[workspaceId];
    else next[workspaceId] = message;
    setupScriptErrorByWorkspace.value = next;
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function loadSetupScript(workspaceId: string): Promise<void> {
    const seq = nextScriptSeq(workspaceId);
    const promise = (async () => {
      try {
        const script = await getKimiWebApi().getWorktreeSetupScript(workspaceId);
        if (scriptSeqByWorkspace.get(workspaceId) !== seq) return;
        setupScriptByWorkspace.value = { ...setupScriptByWorkspace.value, [workspaceId]: script };
        setSetupScriptError(workspaceId, null);
      } catch (error) {
        if (scriptSeqByWorkspace.get(workspaceId) === seq) setSetupScriptError(workspaceId, errorMessage(error));
      }
    })().finally(() => {
      if (scriptInFlightByWorkspace.get(workspaceId) === promise) scriptInFlightByWorkspace.delete(workspaceId);
    });
    scriptInFlightByWorkspace.set(workspaceId, promise);
    return promise;
  }

  function ensureSetupScript(workspaceId: string | null | undefined, options?: { force?: boolean }): Promise<void> {
    if (workspaceId === null || workspaceId === undefined || !supportsWorktree(workspaceId)) return Promise.resolve();
    const inFlight = scriptInFlightByWorkspace.get(workspaceId);
    if (inFlight !== undefined) return inFlight;
    if (options?.force !== true && setupScriptByWorkspace.value[workspaceId] !== undefined) return Promise.resolve();
    return loadSetupScript(workspaceId);
  }

  async function saveSetupScript(workspaceId: string, content: string): Promise<boolean> {
    const seq = nextScriptSeq(workspaceId);
    try {
      const script = await getKimiWebApi().saveWorktreeSetupScript(workspaceId, content);
      if (scriptSeqByWorkspace.get(workspaceId) === seq) {
        setupScriptByWorkspace.value = { ...setupScriptByWorkspace.value, [workspaceId]: script };
        setSetupScriptError(workspaceId, null);
      }
      return true;
    } catch (error) {
      if (scriptSeqByWorkspace.get(workspaceId) === seq) setSetupScriptError(workspaceId, errorMessage(error));
      return false;
    }
  }

  function worktreeRequest(workspaceId: string | null | undefined): AppWorktreeSetupRequest | undefined {
    if (effectiveEnvironment(workspaceId) !== 'worktree') return undefined;
    const selected = selection(workspaceId);
    if (selected === null) return undefined;
    return buildWorktreeSetupRequest(selected, {
      useRemote: useRemote(workspaceId),
      runSetupScript: setupScript(workspaceId)?.exists === true && !runSetupScript.value ? false : undefined,
    });
  }

  function view(workspaceId: string | null | undefined): NewSessionEnvironmentView {
    const state = workspaceId === null || workspaceId === undefined ? undefined : branchesByWorkspace.value[workspaceId];
    const info = state?.info;
    const selected = selection(workspaceId);
    const remoteAvailable = selected?.branch.remoteRef !== undefined;
    const remoteOn = useRemote(workspaceId);
    return {
      preferred: preferred.value,
      effective: effectiveEnvironment(workspaceId),
      availability: availability(workspaceId),
      headBranch: info?.headBranch,
      branches: info?.branches ?? [],
      remotes: info?.remotes ?? [],
      selection: selected,
      canIncludeLocalChanges:
        info !== undefined && info.headBranch !== undefined && canIncludeLocalChanges(info, info.headBranch),
      remoteAvailable,
      useRemote: remoteOn,
      usesRemote: remoteOn && remoteAvailable,
      setupScript: setupScript(workspaceId),
      runSetupScript: runSetupScript.value,
    };
  }

  watch(
    () => (preferred.value === 'worktree' ? workspacesStore().activeWorkspaceId : null),
    (workspaceId) => {
      void ensureBranches(workspaceId);
      void ensureSetupScript(workspaceId);
    },
  );

  function reset(): void {
    preferred.value = 'local';
    branchesByWorkspace.value = {};
    sourceByWorkspace.value = {};
    useRemoteByWorkspace.value = {};
    runSetupScript.value = true;
    setupScriptByWorkspace.value = {};
    setupScriptErrorByWorkspace.value = {};
    for (const [workspaceId, seq] of requestSeqByWorkspace) requestSeqByWorkspace.set(workspaceId, seq + 1);
    for (const [workspaceId, seq] of scriptSeqByWorkspace) scriptSeqByWorkspace.set(workspaceId, seq + 1);
    inFlightByWorkspace.clear();
    scriptInFlightByWorkspace.clear();
  }

  return {
    preferred,
    branchesByWorkspace,
    sourceByWorkspace,
    useRemoteByWorkspace,
    runSetupScript,
    selectEnvironment,
    ensureBranches,
    refreshBranches,
    availability,
    effectiveEnvironment,
    selection,
    selectSource,
    useRemote,
    setUseRemote,
    setRunSetupScript,
    setupScriptByWorkspace,
    setupScript,
    setupScriptError,
    ensureSetupScript,
    saveSetupScript,
    worktreeRequest,
    view,
    reset,
  };
});

export function newSessionEnvironmentStore() {
  return useNewSessionEnvironmentStore(clientPinia);
}
