import { createDecorator } from "#/_base/di/instantiation";
import type { IDisposable } from "#/_base/di/lifecycle";
import type { ContentPart } from "#/app/llmProtocol/message";

export interface ContextInjectionContext {
  /** Live positions of this variant's injections in the current history, ascending. */
  readonly injectedPositions: readonly number[];
  /** Position of the newest live injection; `null` when none survive. */
  readonly lastInjectedAt: number | null;
  /**
   * `true` on the first inject run after a `turn.started` event (or after the
   * service starts), then `false` until the next turn. Injectors that should
   * fire once per turn can gate on this flag.
   */
  readonly isNewTurn: boolean;
}

/**
 * Content a context injection provider can return. A plain `string` is wrapped
 * in `<system-reminder>` tags; a {@link ContentPart} array is appended verbatim,
 * allowing providers to inject rich content (e.g. multi-part or media content).
 */
export type ContextInjectionContent = string | readonly ContentPart[];

export type ContextInjectionProvider = (
  context: ContextInjectionContext,
) => ContextInjectionContent | undefined | Promise<ContextInjectionContent | undefined>;

export interface IAgentContextInjectorService {
  readonly _serviceBrand: undefined;

  register(
    name: string,
    provider: ContextInjectionProvider,
  ): IDisposable;

  /**
   * Re-arm the per-turn injectors and run them immediately. Called by full
   * compaction after the summary is applied so the first post-compaction
   * request already carries the per-turn reminders (goal, plan, ...) that the
   * compaction folded away.
   */
  injectAfterCompaction(): Promise<void>;
}

export const IAgentContextInjectorService = createDecorator<IAgentContextInjectorService>(
  'agentContextInjectorService',
);
