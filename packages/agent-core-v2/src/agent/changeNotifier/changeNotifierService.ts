import { createHash } from 'node:crypto';

import { normalize } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { loadAgentsMdForRoots, splitAgentsMdFiles, type LoadedAgentsMd } from '#/agent/profile/context';
import { resolveSubagentModelPool, type SubagentModelPool } from '#/session/subagent/configSection';
import { isToolActiveComposed } from '#/agent/toolPolicy/evaluate';
import { TOOLS_SECTION, type ToolsConfig } from '#/agent/toolPolicy/configSection';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { workspaceRootKey } from '#/_base/utils/workdir-slug';

import {
  IAgentChangeNotifierService,
  type BeliefsSeed,
  type SubagentChangesInput,
  type SubagentModelPoolSnapshot,
} from './changeNotifier';
import {
  ChangeNotifierSnapshotEvent,
  changeNotifierSnapshotKey,
  type ChangeNotifierSnapshotState,
} from './changeNotifierOps';

const AGENTS_MD_CHANGE_VARIANT = 'agents_md_change';
const SKILLS_CHANGE_VARIANT = 'skills_change';
const SUBAGENTS_CHANGE_VARIANT = 'subagents_change';
const WORKSPACE_DIRS_CHANGE_VARIANT = 'workspace_dirs_change';

const SKILL_LISTING_MARKER = 'DISREGARD any earlier skill listings';

interface AgentsMdChanges {
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly added: readonly string[];
}

interface WorkspacePrimaryChange {
  readonly workspaceId: string;
  readonly from: string;
  readonly to: string;
}

interface WorkspaceDirsChanges {
  readonly primary: readonly WorkspacePrimaryChange[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export class AgentChangeNotifierService extends Disposable implements IAgentChangeNotifierService {
  declare readonly _serviceBrand: undefined;

  private muted = false;
  private workspaceDirsNotificationTail: Promise<void> = Promise.resolve();

  private legacySubagentBaseline:
    | { readonly names: readonly string[]; readonly pool: SubagentModelPoolSnapshot | undefined }
    | undefined;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @ISessionAgentProfileCatalog private readonly agentCatalog: ISessionAgentProfileCatalog,
    @IAgentReminderService private readonly reminder: IAgentReminderService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @IHostFileSystem private readonly localFs: IHostFileSystem,
    @IHostEnvironment private readonly localEnvironment: IHostEnvironment,
    @IConfigService private readonly config: IConfigService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionWorkspaceInfo private readonly workspaceInfo: ISessionWorkspaceInfo,
    @ISessionInstructionsProvider private readonly instructions: ISessionInstructionsProvider,
    @ISessionToolPolicy private readonly sessionToolPolicy: ISessionToolPolicy,
    @ISessionToolPolicyGate private readonly toolPolicyGate: ISessionToolPolicyGate,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.states.contributeState(changeNotifierSnapshotKey);
    this._register(
      this.instructions.onDidChange(() => {
        void this.notifyAgentsMdChanges();
      }),
    );
    this._register(
      this.skillCatalog.onDidChange(() => {
        void this.notifySkillChanges();
      }),
    );
    this._register(
      this.agentCatalog.onDidChange(() => {
        void this.notifySubagentChanges();
      }),
    );
    this._register(
      this.workspaceInfo.onDidChange(() => {
        void this.notifyWorkspaceDirsChanges();
      }),
    );
    void this.agentCatalog.ready.then(() => {
      if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
      if (this.snapshot.subagentNames !== undefined) return;
      this.legacySubagentBaseline = {
        names: this.agentCatalog.list().map((profile) => profile.name),
        pool: snapshotModelPool(resolveSubagentModelPool(this.config)),
      };
    });
  }

  private get snapshot(): ChangeNotifierSnapshotState {
    return this.states.get(changeNotifierSnapshotKey);
  }

  mute(): void {
    this.muted = true;
  }

  unmute(): void {
    this.muted = false;
  }

  async notifyAgentsMdChanges(): Promise<void> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID || this.muted) return;
    try {
      const profileData = this.profile.data();
      if (profileData.profileName === undefined) return;
      const lease = this.environment.acquire(['fs']);
      let fresh: LoadedAgentsMd;
      try {
        fresh = await loadAgentsMdForRoots(
          { fs: lease.environment.fs!, homeDir: this.localEnvironment.homeDir },
          this.bootstrap.homeDir,
          [this.environment.workspaceRoots().workDir],
          this.localFs,
        );
      } finally {
        lease.dispose();
      }
      const contents = fresh.files;
      const hash = hashText(`${fresh.paths.join('\n')}\n\n${fresh.content}`);
      const snapshot = this.snapshot;
      if (snapshot.agentsMdHash === hash || this.muted) return;
      const currentFiles = hashAgentsMdContents(contents);
      await this.recordSnapshot({ agentsMdHash: hash, agentsMdFiles: currentFiles });
      const changes =
        snapshot.agentsMdFiles !== undefined
          ? classifyAgainstBeliefs(snapshot.agentsMdFiles, fresh.paths, currentFiles)
          : classifyAgentsMdChanges(
              profileData.systemPrompt,
              profileData.agentsMdPaths ?? [],
              fresh.paths,
              contents,
            );
      if (changes.modified.length + changes.deleted.length + changes.added.length === 0) return;
      this.reminder.notify(agentsMdChangeText(changes), { variant: AGENTS_MD_CHANGE_VARIANT });
    } catch (error) {
      this.log.warn('agents.md change notification failed', { error });
    }
  }

  async notifySkillChanges(): Promise<void> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID || this.muted) return;
    try {
      const profileData = this.profile.data();
      if (profileData.profileName === undefined) return;
      await this.skillCatalog.ready;
      const listing = this.skillCatalog.catalog.getModelSkillListing();
      const hash = hashText(listing);
      const snapshot = this.snapshot;
      if (snapshot.skillsHash === hash || this.muted) return;
      await this.recordSnapshot({ skillsHash: hash });
      if (snapshot.skillsHash === undefined) {
        if (listing === '') {
          if (!profileData.systemPrompt.includes(SKILL_LISTING_MARKER)) return;
        } else if (
          profileData.systemPrompt.includes(`${listing}\n\n`) ||
          profileData.systemPrompt.endsWith(listing)
        ) {
          return;
        }
      }
      if (!this.toolActiveForBoundProfile(profileData, 'Skill')) return;
      this.reminder.notify(skillsChangeText(listing), { variant: SKILLS_CHANGE_VARIANT });
    } catch (error) {
      this.log.warn('skill change notification failed', { error });
    }
  }

  private toolActiveForBoundProfile(profileData: ProfileData, name: string): boolean {
    if (profileData.profileName === undefined) return false;
    return isToolActiveComposed(
      {
        workspaceDisabledTools: this.toolPolicyGate.disabledTools,
        profile: {
          tools: profileData.activeToolNames,
          disallowedTools: profileData.disallowedTools,
        },
        global: this.config.get<ToolsConfig>(TOOLS_SECTION),
        sessionDisabledTools: this.sessionToolPolicy.disabledTools(),
      },
      name,
    );
  }

  private boundExplicitAllowlist(profileData: ProfileData): readonly string[] | undefined {
    if (profileData.profileName === undefined || profileData.profileName === DEFAULT_AGENT_PROFILE_NAME) {
      return undefined;
    }
    const declared = profileData.subagents;
    if (declared === undefined || (declared.length === 1 && declared[0] === '*')) return undefined;
    return declared;
  }

  async notifySubagentChanges(input?: SubagentChangesInput): Promise<void> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID || this.muted) return;
    try {
      const profileData = this.profile.data();
      if (profileData.profileName === undefined) return;
      await this.agentCatalog.ready;
      const currentProfileList = this.agentCatalog.list();
      const currentProfiles = currentProfileList.map((profile) => profile.name);
      const currentPool = snapshotModelPool(resolveSubagentModelPool(this.config));
      const snapshot = this.snapshot;
      if (
        snapshot.subagentNames !== undefined &&
        sameStringSet(currentProfiles, snapshot.subagentNames) &&
        sameModelPool(currentPool, snapshot.modelPool)
      ) {
        return;
      }
      if (this.muted) return;
      const baseProfiles =
        snapshot.subagentNames ??
        input?.previousSubagentNames ??
        this.legacySubagentBaseline?.names ??
        currentProfiles;
      const basePool =
        snapshot.subagentNames !== undefined
          ? (snapshot.modelPool ?? null)
          : input?.previousModelPool !== undefined
            ? input.previousModelPool
            : this.legacySubagentBaseline !== undefined
              ? (this.legacySubagentBaseline.pool ?? null)
              : currentPool;
      const profilesAdded = difference(currentProfiles, baseProfiles).map((name) => {
        const profile = currentProfileList.find((candidate) => candidate.name === name);
        return { name, description: profile?.description, whenToUse: profile?.whenToUse };
      });
      const profilesRemoved = difference(baseProfiles, currentProfiles);
      const modelsAdded = difference(poolAliases(currentPool), poolAliases(basePool));
      const modelsRemoved = difference(poolAliases(basePool), poolAliases(currentPool));
      const modelsUpdated = poolAliases(currentPool).filter(
        (alias) =>
          basePool?.models[alias] !== undefined &&
          basePool.models[alias] !== currentPool?.models[alias],
      );
      const defaultModelChange =
        currentPool !== undefined &&
        basePool !== null &&
        basePool !== undefined &&
        currentPool.defaultModel !== basePool.defaultModel
          ? { from: basePool.defaultModel, to: currentPool.defaultModel }
          : undefined;
      const allowlist = this.boundExplicitAllowlist(profileData);
      const visibleAdded =
        allowlist === undefined
          ? profilesAdded
          : profilesAdded.filter((profile) => allowlist.includes(profile.name));
      const visibleRemoved =
        allowlist === undefined
          ? profilesRemoved
          : profilesRemoved.filter((name) => allowlist.includes(name));
      await this.recordSnapshot({ subagentNames: currentProfiles, modelPool: currentPool });
      if (
        visibleAdded.length +
          visibleRemoved.length +
          modelsAdded.length +
          modelsRemoved.length +
          modelsUpdated.length ===
          0 &&
        defaultModelChange === undefined
      ) {
        return;
      }
      if (
        !this.toolActiveForBoundProfile(profileData, 'Agent') &&
        !this.toolActiveForBoundProfile(profileData, 'AgentSwarm')
      ) {
        return;
      }
      this.reminder.notify(
        subagentsChangeText({
          profilesAdded: visibleAdded,
          profilesRemoved: visibleRemoved,
          modelsAdded,
          modelsRemoved,
          modelsUpdated,
          defaultModelChange,
        }),
        { variant: SUBAGENTS_CHANGE_VARIANT },
      );
    } catch (error) {
      this.log.warn('subagent change notification failed', { error });
    }
  }

  notifyWorkspaceDirsChanges(): Promise<void> {
    return this.enqueueWorkspaceDirsNotification(() => this.notifyWorkspaceDirsChangesNow());
  }

  private enqueueWorkspaceDirsNotification<T>(work: () => Promise<T>): Promise<T> {
    const run = this.workspaceDirsNotificationTail.then(work, work);
    this.workspaceDirsNotificationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async notifyWorkspaceDirsChangesNow(): Promise<void> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID || this.muted) return;
    try {
      await this.workspaceInfo.ready;
      if (this.muted) return;
      const primaryByWorkspace = { ...this.workspaceInfo.primaryByWorkspace };
      const additionalDirs = [...this.workspaceInfo.additionalDirs];
      const snapshot = this.snapshot;
      if (
        samePrimarySnapshot(snapshot.workspacePrimaryByWorkspace, primaryByWorkspace) &&
        sameDirectorySnapshot(snapshot.workspaceAdditionalDirs, additionalDirs)
      ) {
        return;
      }
      if (this.muted) return;
      await this.recordSnapshot({
        workspacePrimaryByWorkspace: primaryByWorkspace,
        workspaceAdditionalDirs: additionalDirs,
      });
      if (this.muted) {
        await this.recordSnapshot({
          workspacePrimaryByWorkspace: snapshot.workspacePrimaryByWorkspace,
          workspaceAdditionalDirs: snapshot.workspaceAdditionalDirs,
        });
        return;
      }
      if (
        snapshot.workspacePrimaryByWorkspace === undefined &&
        snapshot.workspaceAdditionalDirs === undefined
      ) {
        return;
      }
      const changes = diffWorkspaceDirs(
        snapshot.workspacePrimaryByWorkspace ?? {},
        snapshot.workspaceAdditionalDirs ?? [],
        primaryByWorkspace,
        additionalDirs,
      );
      if (changes.primary.length + changes.added.length + changes.removed.length === 0) return;
      this.reminder.notify(workspaceDirsChangeText(changes, this.sessionContext.cwd), {
        variant: WORKSPACE_DIRS_CHANGE_VARIANT,
      });
    } catch (error) {
      this.log.warn('workspace directory change notification failed', { error });
    }
  }

  seedBeliefs(seed: BeliefsSeed): Promise<void> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return Promise.resolve();
    return this.enqueueWorkspaceDirsNotification(() => this.seedBeliefsNow(seed));
  }

  private async seedBeliefsNow(seed: BeliefsSeed): Promise<void> {
    try {
      await this.workspaceInfo.ready;
      const files = hashAgentsMdContents(splitAgentsMdFiles(seed.agentsMd, seed.agentsMdPaths));
      const pool = resolveSubagentModelPool(this.config);
      const snapshot = this.snapshot;
      await this.recordSnapshot({
        agentsMdHash: undefined,
        agentsMdFiles: files,
        skillsHash: hashText(seed.skillsListing),
        subagentNames: this.agentCatalog.list().map((profile) => profile.name),
        modelPool: snapshotModelPool(pool),
        workspacePrimaryByWorkspace:
          snapshot.workspacePrimaryByWorkspace ?? { ...this.workspaceInfo.primaryByWorkspace },
        workspaceAdditionalDirs:
          snapshot.workspaceAdditionalDirs ?? [...this.workspaceInfo.additionalDirs],
      });
    } catch (error) {
      this.log.warn('change notifier belief seeding failed', { error });
    }
  }

  private async recordSnapshot(patch: Partial<ChangeNotifierSnapshotState>): Promise<void> {
    const next = { ...this.snapshot, ...patch };
    await this.dispatcher.dispatch(
      new ChangeNotifierSnapshotEvent({
        agentId: this.scopeContext.agentId,
        agentsMdHash: next.agentsMdHash ?? null,
        agentsMdFiles: next.agentsMdFiles !== undefined ? { ...next.agentsMdFiles } : null,
        skillsHash: next.skillsHash ?? null,
        subagentNames: next.subagentNames !== undefined ? [...next.subagentNames] : null,
        modelPool:
          next.modelPool !== undefined
            ? { ...next.modelPool, models: { ...next.modelPool.models } }
            : null,
        workspacePrimaryByWorkspace:
          next.workspacePrimaryByWorkspace !== undefined
            ? { ...next.workspacePrimaryByWorkspace }
            : null,
        workspaceAdditionalDirs:
          next.workspaceAdditionalDirs !== undefined ? [...next.workspaceAdditionalDirs] : null,
      }),
    );
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function snapshotModelPool(pool: SubagentModelPool | undefined): SubagentModelPoolSnapshot | undefined {
  if (pool === undefined) return undefined;
  return { defaultModel: pool.defaultModel, models: { ...pool.models } };
}

function poolAliases(pool: SubagentModelPoolSnapshot | null | undefined): readonly string[] {
  return pool === undefined || pool === null ? [] : Object.keys(pool.models);
}

function sameModelPool(
  left: SubagentModelPoolSnapshot | null | undefined,
  right: SubagentModelPoolSnapshot | null | undefined,
): boolean {
  if (left === undefined || left === null || right === undefined || right === null) {
    return (left ?? null) === (right ?? null);
  }
  if (left.defaultModel !== right.defaultModel) return false;
  const leftAliases = Object.keys(left.models);
  const rightAliases = Object.keys(right.models);
  return (
    leftAliases.length === rightAliases.length &&
    leftAliases.every((alias) => right.models[alias] === left.models[alias])
  );
}

function hashAgentsMdContents(contents: ReadonlyMap<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [path, content] of contents) {
    result[path] = hashText(content);
  }
  return result;
}

function classifyAgainstBeliefs(
  beliefs: Readonly<Record<string, string>>,
  currentPaths: readonly string[],
  currentFiles: Readonly<Record<string, string>>,
): AgentsMdChanges {
  const current = new Set(currentPaths.map(normalize));
  const beliefPaths = new Set(Object.keys(beliefs));
  const deleted = [...beliefPaths].filter((path) => !current.has(path));
  const added = [...current].filter((path) => !beliefPaths.has(path));
  const modified: string[] = [];
  for (const path of current) {
    if (!beliefPaths.has(path)) continue;
    const currentHash = currentFiles[path];
    if (currentHash === undefined) continue;
    if (beliefs[path] !== currentHash) modified.push(path);
  }
  return { modified, deleted, added };
}

function classifyAgentsMdChanges(
  systemPrompt: string,
  previousPaths: readonly string[],
  currentPaths: readonly string[],
  contents: ReadonlyMap<string, string>,
): AgentsMdChanges {
  const previous = new Set(previousPaths.map(normalize));
  const current = new Set(currentPaths.map(normalize));
  const deleted = [...previous].filter((path) => !current.has(path));
  const added = [...current].filter((path) => !previous.has(path));
  const modified: string[] = [];
  for (const path of current) {
    if (!previous.has(path)) continue;
    const content = contents.get(path);
    if (content === undefined) continue;
    const injected = `<!-- From: ${path} -->\n${content}`;
    if (systemPrompt.includes(`${injected}\n\n`) || systemPrompt.endsWith(injected)) continue;
    modified.push(path);
  }
  return { modified, deleted, added };
}

function agentsMdChangeText(changes: AgentsMdChanges): string {
  const sections: string[] = [];
  if (changes.modified.length + changes.deleted.length > 0) {
    const stale = new Set(changes.deleted);
    sections.push(
      'The AGENTS.md instruction file(s) below changed on disk after they were injected into the system prompt:\n' +
        [...changes.modified, ...changes.deleted]
          .map((path) => `- ${path}${stale.has(path) ? ' (deleted)' : ''}`)
          .join('\n') +
        '\nRead the current file(s) and follow the latest contents; the copies injected in the system prompt are stale.',
    );
  }
  if (changes.added.length > 0) {
    sections.push(
      'The following AGENTS.md file(s) exist in your workspace but were not included in your system prompt:\n' +
        changes.added.map((path) => `- ${path}`).join('\n') +
        '\nRead them before making changes in those directories.',
    );
  }
  return sections.join('\n\n');
}

function skillsChangeText(listing: string): string {
  if (listing === '') {
    return 'The skill catalog changed since your system prompt was rendered; no skills are currently available.';
  }
  return `The skill catalog changed since your system prompt was rendered; the listing below replaces it.\n\n${listing}`;
}

function addedProfileLabel(profile: {
  readonly name: string;
  readonly description?: string;
  readonly whenToUse?: string;
}): string {
  const details = [profile.description, profile.whenToUse].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return details.length === 0 ? profile.name : `${profile.name} (${details.join('; ')})`;
}

function subagentsChangeText(diff: {
  readonly profilesAdded: readonly {
    readonly name: string;
    readonly description?: string;
    readonly whenToUse?: string;
  }[];
  readonly profilesRemoved: readonly string[];
  readonly modelsAdded: readonly string[];
  readonly modelsRemoved: readonly string[];
  readonly modelsUpdated: readonly string[];
  readonly defaultModelChange?: { readonly from?: string; readonly to?: string };
}): string {
  const lines = ['The available subagent profiles and models changed:'];
  if (diff.profilesAdded.length > 0) {
    lines.push(`- Profiles added: ${diff.profilesAdded.map(addedProfileLabel).join(', ')}`);
  }
  if (diff.profilesRemoved.length > 0) {
    lines.push(`- Profiles removed: ${diff.profilesRemoved.join(', ')}`);
  }
  if (diff.modelsAdded.length > 0) lines.push(`- Models added: ${diff.modelsAdded.join(', ')}`);
  if (diff.modelsRemoved.length > 0) lines.push(`- Models removed: ${diff.modelsRemoved.join(', ')}`);
  if (diff.modelsUpdated.length > 0) {
    lines.push(`- Model descriptions updated: ${diff.modelsUpdated.join(', ')}`);
  }
  if (diff.defaultModelChange !== undefined) {
    const { from, to } = diff.defaultModelChange;
    if (from !== undefined && to !== undefined) {
      lines.push(`- Default model changed: ${from} → ${to}`);
    } else if (to !== undefined) {
      lines.push(`- Default model set: ${to}`);
    } else if (from !== undefined) {
      lines.push(`- Default model cleared (was ${from})`);
    }
  }
  lines.push('You can use them right away — the Agent tool validates subagent_type against the live catalog.');
  return lines.join('\n');
}

function samePrimarySnapshot(
  previous: Readonly<Record<string, string>> | undefined,
  current: Readonly<Record<string, string>>,
): boolean {
  if (previous === undefined) return false;
  const previousIds = Object.keys(previous);
  const currentIds = Object.keys(current);
  return (
    previousIds.length === currentIds.length &&
    previousIds.every((id) => {
      const before = previous[id];
      const after = current[id];
      return (
        before !== undefined &&
        after !== undefined &&
        workspaceRootKey(before) === workspaceRootKey(after)
      );
    })
  );
}

function sameDirectorySnapshot(
  previous: readonly string[] | undefined,
  current: readonly string[],
): boolean {
  if (previous === undefined) return false;
  const before = directoryKeys(previous);
  const after = directoryKeys(current);
  return before.size === after.size && [...before].every((path) => after.has(path));
}

function directoryKeys(dirs: readonly string[]): Set<string> {
  return new Set(dirs.map((dir) => workspaceRootKey(dir)));
}

function directoryDifference(
  left: readonly string[],
  right: readonly string[],
  excluded: ReadonlySet<string>,
): string[] {
  const rightKeys = directoryKeys(right);
  const seen = new Set<string>();
  return left.filter((dir) => {
    const key = workspaceRootKey(dir);
    if (rightKeys.has(key) || excluded.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function diffWorkspaceDirs(
  previousPrimary: Readonly<Record<string, string>>,
  previousDirs: readonly string[],
  currentPrimary: Readonly<Record<string, string>>,
  currentDirs: readonly string[],
): WorkspaceDirsChanges {
  const primary: WorkspacePrimaryChange[] = [];
  for (const workspaceId of Object.keys(currentPrimary).toSorted()) {
    const from = previousPrimary[workspaceId];
    const to = currentPrimary[workspaceId];
    if (from === undefined || to === undefined) continue;
    if (workspaceRootKey(from) !== workspaceRootKey(to)) {
      primary.push({ workspaceId, from, to });
    }
  }
  const primaryPaths = new Set(
    primary.flatMap((change) => [workspaceRootKey(change.from), workspaceRootKey(change.to)]),
  );
  return {
    primary,
    added: directoryDifference(currentDirs, previousDirs, primaryPaths),
    removed: directoryDifference(previousDirs, currentDirs, primaryPaths),
  };
}

function workspaceDirsChangeText(changes: WorkspaceDirsChanges, cwd: string): string {
  const lines = ['Project directory configuration changed.'];
  for (const change of changes.primary) {
    lines.push(
      `Primary directory for project ${change.workspaceId}: ${change.from} -> ${change.to}.`,
    );
  }
  if (changes.added.length > 0) lines.push(`Added directories: ${changes.added.join(', ')}.`);
  if (changes.removed.length > 0) {
    lines.push(`Removed directories: ${changes.removed.join(', ')}.`);
  }
  lines.push(`Session cwd remains ${cwd}.`);
  lines.push(
    'The updated directory set is already effective for subsequent tool calls and supersedes earlier directory information.',
  );
  return lines.join('\n');
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentChangeNotifierService,
  AgentChangeNotifierService,
  ScopeActivation.OnScopeCreated,
  'changeNotifier',
);
