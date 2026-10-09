import { createHash } from 'node:crypto';

import { normalize } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { loadAgentsMdForRoots, type LoadedAgentsMd } from '#/agent/profile/context';
import { resolveSubagentModelPool } from '#/session/subagent/configSection';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import {
  IAgentChangeNotifierService,
  type SubagentChangesInput,
} from './changeNotifier';
import {
  ChangeNotifierSnapshotEvent,
  changeNotifierSnapshotKey,
  type ChangeNotifierSnapshotState,
} from './changeNotifierOps';

const AGENTS_MD_CHANGE_VARIANT = 'agents_md_change';
const SKILLS_CHANGE_VARIANT = 'skills_change';
const SUBAGENTS_CHANGE_VARIANT = 'subagents_change';

const SKILL_LISTING_MARKER = 'DISREGARD any earlier skill listings';

interface AgentsMdChanges {
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly added: readonly string[];
}

export class AgentChangeNotifierService extends Disposable implements IAgentChangeNotifierService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @ISessionAgentProfileCatalog private readonly agentCatalog: ISessionAgentProfileCatalog,
    @IAgentReminderService private readonly reminder: IAgentReminderService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IConfigService private readonly config: IConfigService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.states.contributeState(changeNotifierSnapshotKey);
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
  }

  private get snapshot(): ChangeNotifierSnapshotState {
    return this.states.get(changeNotifierSnapshotKey);
  }

  async notifyAgentsMdChanges(): Promise<void> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    try {
      const profileData = this.profile.data();
      if (profileData.profileName === undefined) return;
      const lease = this.runtime.acquire(['fs']);
      let fresh: LoadedAgentsMd;
      let contents: ReadonlyMap<string, string>;
      try {
        const fs = lease.runtime.fs!;
        fresh = await loadAgentsMdForRoots(
          { fs, homeDir: lease.runtime.environment.homeDir },
          this.bootstrap.homeDir,
          [this.sessionContext.cwd],
        );
        contents = await readAgentsMdFileContents(fs, fresh.paths);
      } finally {
        lease.dispose();
      }
      const hash = hashText(`${fresh.paths.join('\n')}\n\n${fresh.content}`);
      if (this.snapshot.agentsMdHash === hash) return;
      this.recordSnapshot({ agentsMdHash: hash });
      const changes = classifyAgentsMdChanges(
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
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    try {
      const profileData = this.profile.data();
      if (profileData.profileName === undefined) return;
      await this.skillCatalog.ready;
      const listing = this.skillCatalog.catalog.getModelSkillListing();
      const hash = hashText(listing);
      if (this.snapshot.skillsHash === hash) return;
      this.recordSnapshot({ skillsHash: hash });
      if (listing === '') {
        if (!profileData.systemPrompt.includes(SKILL_LISTING_MARKER)) return;
      } else if (profileData.systemPrompt.includes(listing)) {
        return;
      }
      this.reminder.notify(skillsChangeText(listing), { variant: SKILLS_CHANGE_VARIANT });
    } catch (error) {
      this.log.warn('skill change notification failed', { error });
    }
  }

  async notifySubagentChanges(input?: SubagentChangesInput): Promise<void> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    try {
      const profileData = this.profile.data();
      if (profileData.profileName === undefined) return;
      await this.agentCatalog.ready;
      const currentProfiles = this.agentCatalog.list().map((profile) => profile.name);
      const pool = resolveSubagentModelPool(this.config);
      const currentAliases = pool === undefined ? undefined : Object.keys(pool.models);
      const snapshot = this.snapshot;
      if (
        snapshot.subagentNames !== undefined &&
        sameStringSet(currentProfiles, snapshot.subagentNames) &&
        sameStringSet(currentAliases ?? [], snapshot.modelPoolAliases ?? [])
      ) {
        return;
      }
      const baseProfiles =
        input?.previousSubagentNames ?? snapshot.subagentNames ?? currentProfiles;
      const baseAliases =
        input?.previousModelPoolAliases ?? snapshot.modelPoolAliases ?? currentAliases;
      const profilesAdded = difference(currentProfiles, baseProfiles);
      const profilesRemoved = difference(baseProfiles, currentProfiles);
      const modelsAdded = difference(currentAliases ?? [], baseAliases ?? []);
      const modelsRemoved = difference(baseAliases ?? [], currentAliases ?? []);
      this.recordSnapshot({
        subagentNames: currentProfiles,
        modelPoolAliases: currentAliases,
      });
      if (
        profilesAdded.length +
          profilesRemoved.length +
          modelsAdded.length +
          modelsRemoved.length ===
        0
      ) {
        return;
      }
      this.reminder.notify(
        subagentsChangeText({ profilesAdded, profilesRemoved, modelsAdded, modelsRemoved }),
        { variant: SUBAGENTS_CHANGE_VARIANT },
      );
    } catch (error) {
      this.log.warn('subagent change notification failed', { error });
    }
  }

  private recordSnapshot(patch: Partial<ChangeNotifierSnapshotState>): void {
    const next = { ...this.snapshot, ...patch };
    void this.dispatcher.dispatch(
      new ChangeNotifierSnapshotEvent({
        agentId: this.scopeContext.agentId,
        agentsMdHash: next.agentsMdHash ?? null,
        skillsHash: next.skillsHash ?? null,
        subagentNames: next.subagentNames !== undefined ? [...next.subagentNames] : null,
        modelPoolAliases: next.modelPoolAliases !== undefined ? [...next.modelPoolAliases] : null,
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

async function readAgentsMdFileContents(
  fs: IHostFileSystem,
  paths: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const contents = new Map<string, string>();
  for (const path of paths) {
    try {
      contents.set(normalize(path), (await fs.readText(path, { errors: 'ignore' })).trim());
    } catch {}
  }
  return contents;
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
    if (content === undefined || content === '') continue;
    if (!systemPrompt.includes(`<!-- From: ${path} -->\n${content}`)) modified.push(path);
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

function subagentsChangeText(diff: {
  readonly profilesAdded: readonly string[];
  readonly profilesRemoved: readonly string[];
  readonly modelsAdded: readonly string[];
  readonly modelsRemoved: readonly string[];
}): string {
  const lines = ['The available subagent profiles and models changed:'];
  if (diff.profilesAdded.length > 0) lines.push(`- Profiles added: ${diff.profilesAdded.join(', ')}`);
  if (diff.profilesRemoved.length > 0) {
    lines.push(`- Profiles removed: ${diff.profilesRemoved.join(', ')}`);
  }
  if (diff.modelsAdded.length > 0) lines.push(`- Models added: ${diff.modelsAdded.join(', ')}`);
  if (diff.modelsRemoved.length > 0) lines.push(`- Models removed: ${diff.modelsRemoved.join(', ')}`);
  lines.push('You can use them right away — the Agent tool validates subagent_type against the live catalog.');
  return lines.join('\n');
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentChangeNotifierService,
  AgentChangeNotifierService,
  ScopeActivation.OnScopeCreated,
  'changeNotifier',
);
