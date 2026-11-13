/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import type { EnvironmentDisclosureSnapshot } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { AgentEvent2, registerEvent2Class } from '#/app/event/event2';
import type { ThinkingEffort } from '@moonshot-ai/core/llm/request';

import { ProfileError, ProfileErrors, type ProfileBindingSnapshot } from './profile';

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

export const EMPTY_LOOP_PROFILE: ProfileBindingSnapshot = {
  thinkingLevel: 'off',
  systemPrompt: '',
  renderGeneration: 0,
};

export interface ProfileUpdatePlan {
  readonly config?: ConfigUpdatePayload;
  readonly tools?: ToolsSetActiveTools | ToolsResetActiveTools;
}

export function reduceLoopProfileBind(
  current: ProfileBindingSnapshot | undefined,
  event: ProfileBind,
): ProfileBindingSnapshot {
  return {
    modelAlias: event.modelAlias ?? current?.modelAlias,
    profileName: event.profileName ?? current?.profileName,
    thinkingLevel: event.thinkingEffort,
    systemPrompt: event.systemPrompt,
    environmentDisclosure: event.environmentDisclosure,
    renderGeneration: event.renderGeneration ?? (current?.renderGeneration ?? 0) + 1,
    agentsMdPaths: event.agentsMdPaths ?? current?.agentsMdPaths,
    activeToolNames: event.activeToolNames,
    disallowedTools: event.disallowedTools,
    subagents: event.subagents,
  };
}

export function reduceLoopConfigUpdate(
  current: ProfileBindingSnapshot,
  event: ConfigUpdatePayload,
): ProfileBindingSnapshot {
  let next: { -readonly [K in keyof ProfileBindingSnapshot]: ProfileBindingSnapshot[K] } | undefined;
  const update = (): { -readonly [K in keyof ProfileBindingSnapshot]: ProfileBindingSnapshot[K] } =>
    next ??= { ...current };
  if (event.modelAlias !== undefined && event.modelAlias !== current.modelAlias) {
    update().modelAlias = event.modelAlias;
  }
  if (event.profileName !== undefined && event.profileName !== current.profileName) {
    update().profileName = event.profileName;
  }
  const thinkingLevel = configUpdateThinkingLevel(event);
  if (thinkingLevel !== undefined && thinkingLevel !== current.thinkingLevel) {
    update().thinkingLevel = thinkingLevel;
  }
  if (
    event.systemPrompt !== undefined &&
    (event.systemPrompt !== current.systemPrompt ||
      event.environmentDisclosure !== undefined ||
      event.renderGeneration !== undefined)
  ) {
    next = update();
    next.systemPrompt = event.systemPrompt;
    next.environmentDisclosure = event.environmentDisclosure;
    next.renderGeneration = event.renderGeneration ?? (current.renderGeneration ?? 0) + 1;
  }
  if (event.agentsMdPaths !== undefined && !stringArrayEqual(event.agentsMdPaths, current.agentsMdPaths)) {
    update().agentsMdPaths = event.agentsMdPaths;
  }
  if (event.disallowedTools !== undefined && !stringArrayEqual(event.disallowedTools, current.disallowedTools)) {
    update().disallowedTools = event.disallowedTools;
  }
  return next ?? current;
}

export function reduceLoopActiveTools(
  current: ProfileBindingSnapshot,
  names: readonly string[] | undefined,
): ProfileBindingSnapshot {
  return stringArrayEqual(names, current.activeToolNames) ? current : { ...current, activeToolNames: names };
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

export type ActiveToolsState = readonly string[] | undefined;

registerEvent2Class(ProfileBind);
registerEvent2Class(ConfigUpdate);
registerEvent2Class(ToolsSetActiveTools);
registerEvent2Class(ToolsResetActiveTools);
