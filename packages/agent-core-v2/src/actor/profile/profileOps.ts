/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { original, type Draft } from 'immer';
import { z } from 'zod';

import type { EnvironmentDisclosureSnapshot } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { AgentEvent2 } from '#/app/event/event2';
import type { ThinkingEffort } from '#/kosong/contract/provider';

import { ProfileError, ProfileErrors } from './errors';

export interface ProfileModelState {
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingLevel: string;
  readonly systemPrompt: string;
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration: number;
  readonly agentsMdPaths?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
}

export type ActiveToolsState = readonly string[] | undefined;

export interface ProfileState {
  readonly profile: ProfileModelState;
  readonly activeTools: ActiveToolsState;
}

export const INITIAL_PROFILE_STATE: ProfileState = {
  profile: {
    thinkingLevel: 'off',
    systemPrompt: '',
    renderGeneration: 0,
  },
  activeTools: undefined,
};

const profileBindSchema = z.object({
  agentId: z.string(),
  modelAlias: z.string().optional(),
  profileName: z.string().optional(),
  thinkingEffort: z.custom<ThinkingEffort>(),
  systemPrompt: z.string(),
  environmentDisclosure: z.custom<EnvironmentDisclosureSnapshot>().optional(),
  renderGeneration: z.number().optional(),
  agentsMdPaths: z.array(z.string()).readonly().optional(),
  activeToolNames: z.array(z.string()).readonly().optional(),
  disallowedTools: z.array(z.string()).readonly(),
  subagents: z.array(z.string()).readonly().optional(),
});

export class ProfileBind extends AgentEvent2<z.infer<typeof profileBindSchema>> {
  static override readonly type = 'profile.bind';
  static override readonly durable = true;
  static override readonly schema = profileBindSchema;
}
export interface ProfileBind {
  readonly agentId: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly systemPrompt: string;
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration?: number;
  readonly agentsMdPaths?: readonly string[];
  readonly activeToolNames?: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly subagents?: readonly string[];
}

const configUpdateSchema = z.object({
  agentId: z.string(),
  modelAlias: z.string().optional(),
  profileName: z.string().optional(),
  thinkingEffort: z.custom<ThinkingEffort>().optional(),
  thinkingLevel: z.custom<ThinkingEffort>().optional(),
  systemPrompt: z.string().optional(),
  environmentDisclosure: z.custom<EnvironmentDisclosureSnapshot>().optional(),
  renderGeneration: z.number().optional(),
  agentsMdPaths: z.array(z.string()).readonly().optional(),
  disallowedTools: z.array(z.string()).readonly().optional(),
});

export type ConfigUpdatePayload = z.infer<typeof configUpdateSchema>;

export class ConfigUpdate extends AgentEvent2<ConfigUpdatePayload> {
  static override readonly type = 'config.update';
  static override readonly durable = true;
  static override readonly schema = configUpdateSchema;
}
export interface ConfigUpdate {
  readonly agentId: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingEffort?: ThinkingEffort;
  readonly thinkingLevel?: ThinkingEffort;
  readonly systemPrompt?: string;
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration?: number;
  readonly agentsMdPaths?: readonly string[];
  readonly disallowedTools?: readonly string[];
}

const toolsSetActiveToolsSchema = z.object({
  agentId: z.string(),
  names: z.array(z.string()).readonly(),
});

export class ToolsSetActiveTools extends AgentEvent2<z.infer<typeof toolsSetActiveToolsSchema>> {
  static override readonly type = 'tools.set_active_tools';
  static override readonly durable = true;
  static override readonly schema = toolsSetActiveToolsSchema;
}
export interface ToolsSetActiveTools {
  readonly agentId: string;
  readonly names: readonly string[];
}

const toolsResetActiveToolsSchema = z.object({ agentId: z.string() });

export class ToolsResetActiveTools extends AgentEvent2<
  z.infer<typeof toolsResetActiveToolsSchema>
> {
  static override readonly type = 'tools.reset_active_tools';
  static override readonly durable = true;
  static override readonly schema = toolsResetActiveToolsSchema;
}
export interface ToolsResetActiveTools {
  readonly agentId: string;
}

export interface WarningIssuedPayload {
  readonly agentId: string;
  readonly message: string;
  readonly code?: string;
}

export class WarningIssued extends AgentEvent2<WarningIssuedPayload> {
  static override readonly type = 'warning';
  static override readonly observable = true;
}
export interface WarningIssued extends WarningIssuedPayload {}

export function foldProfileBind(state: Draft<ProfileState>, event: ProfileBind): ProfileState {
  return {
    profile: {
      modelAlias: event.modelAlias ?? state.profile.modelAlias,
      profileName: event.profileName ?? state.profile.profileName,
      thinkingLevel: event.thinkingEffort,
      systemPrompt: event.systemPrompt,
      environmentDisclosure: event.environmentDisclosure,
      renderGeneration: event.renderGeneration ?? state.profile.renderGeneration + 1,
      agentsMdPaths: event.agentsMdPaths ?? state.profile.agentsMdPaths,
      disallowedTools: event.disallowedTools,
      subagents: event.subagents,
    },
    activeTools: event.activeToolNames,
  };
}

export function foldConfigUpdate(state: Draft<ProfileState>, event: ConfigUpdate): void {
  const s = state.profile;
  if (event.modelAlias !== undefined && event.modelAlias !== s.modelAlias) {
    s.modelAlias = event.modelAlias;
  }
  if (event.profileName !== undefined && event.profileName !== s.profileName) {
    s.profileName = event.profileName;
  }
  const thinkingLevel = configUpdateThinkingLevel(event);
  if (thinkingLevel !== undefined && thinkingLevel !== s.thinkingLevel) {
    s.thinkingLevel = thinkingLevel;
  }
  if (
    event.systemPrompt !== undefined &&
    (event.systemPrompt !== s.systemPrompt ||
      event.environmentDisclosure !== undefined ||
      event.renderGeneration !== undefined)
  ) {
    s.systemPrompt = event.systemPrompt;
    s.environmentDisclosure = event.environmentDisclosure;
    s.renderGeneration = event.renderGeneration ?? s.renderGeneration + 1;
  }
  if (event.agentsMdPaths !== undefined && !stringArrayEqual(event.agentsMdPaths, s.agentsMdPaths)) {
    s.agentsMdPaths = event.agentsMdPaths as string[];
  }
  if (
    event.disallowedTools !== undefined &&
    !stringArrayEqual(event.disallowedTools, s.disallowedTools)
  ) {
    s.disallowedTools = event.disallowedTools as string[];
  }
}

export function foldToolsSetActiveTools(
  state: Draft<ProfileState>,
  event: ToolsSetActiveTools,
): void {
  if (state.activeTools !== undefined && event.names === original(state.activeTools)) return;
  state.activeTools = event.names as string[];
}

export function foldToolsResetActiveTools(state: Draft<ProfileState>): void {
  if (state.activeTools === undefined) return;
  state.activeTools = undefined;
}

function stringArrayEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function configUpdateThinkingLevel(e: ConfigUpdatePayload): ThinkingEffort | undefined {
  if (e.thinkingEffort !== undefined && e.thinkingLevel !== undefined) {
    if (e.thinkingEffort !== e.thinkingLevel) {
      throw new ProfileError(
        ProfileErrors.codes.THINKING_ALIAS_CONFLICT,
        `config.update has conflicting thinkingEffort (${e.thinkingEffort}) and legacy thinkingLevel (${e.thinkingLevel})`,
        {
          type: 'config.update',
          thinkingEffort: e.thinkingEffort,
          thinkingLevel: e.thinkingLevel,
        },
      );
    }
    return e.thinkingEffort;
  }
  if (e.thinkingEffort !== undefined) return e.thinkingEffort;
  return e.thinkingLevel;
}
