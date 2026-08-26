// app-client contracts — small surfaces the consumer application implements to
// plug product-specific behavior into the shared composables.

import type { InjectionKey } from 'vue';
import type { TaskItem } from '@moonshot-ai/app-core/client/types';
import type { SwarmMember } from '@moonshot-ai/app-core/client';

/**
 * Product analytics sink. The desktop app bridges this to its main-process
 * telemetry; the web app keeps the no-op (it does not emit these events
 * today). Composables receive it by injection — they never import a concrete
 * tracker.
 */
export interface ProductTracker {
  track(event: string, payload?: Record<string, unknown>): void;
}

export const noopProductTracker: ProductTracker = {
  track: () => {},
};

let activeProductTracker: ProductTracker = noopProductTracker;

/** Install the real tracker once at app bootstrap (composition root). The
    desktop app passes its IPC bridge adapter; web leaves the no-op default. */
export function setProductTracker(tracker: ProductTracker): void {
  activeProductTracker = tracker;
}

/** Emit a product analytics event through the injected tracker. Shared modules
    call this delegate — they never import a concrete tracker. With the default
    no-op (web) this is inert. */
export function track(event: string, payload?: Record<string, unknown>): void {
  activeProductTracker.track(event, payload);
}

// ---------------------------------------------------------------------------
// Typed provide/inject keys (formerly bare strings scattered across the two
// apps and app-components). Symbol descriptions keep the legacy names for
// grep-ability.
// ---------------------------------------------------------------------------

/** Pin the transcript scroll position around a DOM mutation (e.g. expanding a
    tool card) so the viewport doesn't jump. Provided by the panes that own a
    scroll container (ConversationPane / SideChatPanel / AgentDetailPanel). */
export const PinScrollKey: InjectionKey<(el: HTMLElement, ms?: number) => void> = Symbol('pinScroll');

/** Map a sub-agent tool call id to its agent task id (for detail-panel jumps). */
export const ResolveAgentTaskIdKey: InjectionKey<(toolCallId: string) => string | undefined> =
  Symbol('resolveAgentTaskId');

/** Model label + thinking effort bound to an agent tool call (detail panel). */
export const ResolveAgentModelKey: InjectionKey<
  (toolCallId: string, agentId?: string) => { display?: string; effort?: string } | undefined
> = Symbol('resolveAgentModel');

/** Live task state bound to an agent tool call (spawn-call binding first). */
export const ResolveAgentTaskStateKey: InjectionKey<
  (toolCallId: string, agentId: string | undefined) => TaskItem['state'] | undefined
> = Symbol('resolveAgentTaskState');

/** Members of an agent-swarm tool call, keyed by the call id. */
export const ResolveSwarmMembersKey: InjectionKey<(toolCallId: string) => SwarmMember[] | undefined> =
  Symbol('resolveSwarmMembers');

/** Display name for a model alias, given the loaded model catalog. */
export const ModelDisplayKey: InjectionKey<(alias: string | undefined) => string | undefined> =
  Symbol('modelDisplay');

/** Human-readable suffix for a sub-agent's thinking effort. */
export const SubagentEffortKey: InjectionKey<(effort: string | undefined) => string | undefined> =
  Symbol('subagentEffort');
