
import type { InjectionKey, ComputedRef } from 'vue';
import type { TaskItem } from '@moonshot-ai/app-core/client/types';
import type {
  AppSessionRatingResponse,
  AppSessionRatingView,
  TurnFileHistoryChange,
  TurnFileHistoryContent,
} from '@moonshot-ai/app-core/api';
import type { SwarmMember } from '@moonshot-ai/app-core/client';

export const LatestNotifyToolCallIdKey: InjectionKey<ComputedRef<string | undefined>> = Symbol('latestNotifyToolCallId');
export const NotifyUserEnabledKey: InjectionKey<ComputedRef<boolean>> = Symbol('notifyUserEnabled');

export interface ProductTracker {
  track(event: string, payload?: Record<string, unknown>): void;
}

export const noopProductTracker: ProductTracker = {
  track: () => {},
};

let activeProductTracker: ProductTracker = noopProductTracker;

export function setProductTracker(tracker: ProductTracker): void {
  activeProductTracker = tracker;
}

export function track(event: string, payload?: Record<string, unknown>): void {
  activeProductTracker.track(event, payload);
}

export const PinScrollKey: InjectionKey<(el: HTMLElement, ms?: number) => void> = Symbol('pinScroll');

export const ResolveAgentTaskIdKey: InjectionKey<(toolCallId: string) => string | undefined> =
  Symbol('resolveAgentTaskId');

export const ResolveAgentModelKey: InjectionKey<
  (toolCallId: string, agentId?: string) => { display?: string; effort?: string } | undefined
> = Symbol('resolveAgentModel');

export const ResolveAgentTaskStateKey: InjectionKey<
  (toolCallId: string, agentId: string | undefined) => TaskItem['state'] | undefined
> = Symbol('resolveAgentTaskState');

export const ResolveDetachableTaskKey: InjectionKey<(toolCallId: string) => boolean> =
  Symbol('resolveDetachableTask');

export const ResolveSwarmMembersKey: InjectionKey<(toolCallId: string) => SwarmMember[] | undefined> =
  Symbol('resolveSwarmMembers');

export const ModelDisplayKey: InjectionKey<(alias: string | undefined) => string | undefined> =
  Symbol('modelDisplay');

export type TurnFileChangesResult = readonly TurnFileHistoryChange[] | undefined | 'cancelled';

export interface FetchTurnFileChanges {
  (turnId: number): Promise<TurnFileChangesResult>;
  getSignal(): AbortSignal | undefined;
  peek?(turnId: number): TurnFileChangesResult;
}

export const FetchTurnFileChangesKey: InjectionKey<FetchTurnFileChanges | undefined> =
  Symbol('fetchTurnFileChanges');

export const FetchTurnFileContentKey: InjectionKey<
  (
    turnId: number,
    path: string,
    phase: 'start' | 'end',
    sessionId?: string,
  ) => Promise<TurnFileHistoryContent | undefined>
> = Symbol('fetchTurnFileContent');

export const SubagentEffortKey: InjectionKey<(effort: string | undefined) => string | undefined> =
  Symbol('subagentEffort');

export interface OpenInAppEntry {
  id: string;
  label: string;
  preferred?: boolean;
}

export interface OpenInService {
  catalog(kind?: 'dir' | 'file', filePath?: string): Promise<OpenInAppEntry[]>;
  open(appId: string, target: { path: string; line?: number }): Promise<boolean>;
  icon(appId: string): string;
}

export const OpenInServiceKey: InjectionKey<OpenInService> = Symbol('openInService');

export interface SessionRatingBinding {
  view(sessionId: string): AppSessionRatingView;
  shown(sessionId: string, appearanceId: string): void;
  select(sessionId: string, appearanceId: string, response: AppSessionRatingResponse): void;
  undo(sessionId: string, appearanceId: string): void;
}

export const SessionRatingKey: InjectionKey<SessionRatingBinding> = Symbol('sessionRating');

export const SelectionContextMenuKey: InjectionKey<(selectionText: string) => void> = Symbol('selectionContextMenu');

export type ComposerKeymapAction = 'send' | 'newline' | 'swallow';

export interface ComposerKeyBinding {
  matches(e: KeyboardEvent): boolean;
}

export interface ComposerKeymapContext {
  expanded: boolean;
}

export type ComposerKeymapResolver = (
  action: ComposerKeymapAction,
  ctx: ComposerKeymapContext,
) => ComposerKeyBinding | null;

const defaultComposerKeymapResolver: ComposerKeymapResolver = (action, ctx) => {
  if (action === 'newline') {
    return {
      matches: (e) => e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey,
    };
  }
  if (action === 'send') {
    return {
      matches: (e) =>
        e.key === 'Enter' && !e.shiftKey && !e.altKey && (e.metaKey || e.ctrlKey || !ctx.expanded),
    };
  }
  return null;
};

let activeComposerKeymapResolver: ComposerKeymapResolver = defaultComposerKeymapResolver;

export function setComposerKeymapResolver(resolver: ComposerKeymapResolver | null): void {
  activeComposerKeymapResolver = resolver ?? defaultComposerKeymapResolver;
}

export function resolveComposerBinding(
  action: ComposerKeymapAction,
  ctx: ComposerKeymapContext,
): ComposerKeyBinding | null {
  return activeComposerKeymapResolver(action, ctx);
}

export type RevealInFolder = (path: string) => Promise<boolean>;

export const RevealInFolderKey: InjectionKey<RevealInFolder | undefined> = Symbol('revealInFolder');

export const InsertPathMentionKey: InjectionKey<((path: string, kind: 'file' | 'folder') => void) | undefined> =
  Symbol('insertPathMention');

export const OpenWithDefaultAppKey: InjectionKey<RevealInFolder | undefined> = Symbol('openWithDefaultApp');
